import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { execInContainer, getContainerForUser } from "@/lib/docker";
import { leaseManager } from "@/lib/gpu/lease-manager";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/workspace/<instanceId>/blender/preview
 * Body: { settings?: { samples?, resolution_x?, resolution_y? } }
 *
 * Fire-and-forget: writes request.json (op:"preview") into the instance folder
 * and launches the deterministic Blender render script (run.py op:preview)
 * under nohup. The canvas polls state.json for the phase transition and the
 * updated renders[] preview entry.
 *
 * WHY THIS EXISTS SEPARATELY FROM /render: the agent's interactive previews go
 * through the blender MCP bridge (execute_code), which is bound to a ~120s
 * timeout. Complex scenes exceed that, forcing the agent to drop to 640x360 —
 * too coarse for vision checks (a detached head was missed at that resolution).
 * This route runs op:preview via the helper script, which talks to the same
 * addon socket but with a 600s budget and is fire-and-forget (no HTTP/MCP
 * ceiling). So previews of complex scenes no longer time out, and the vision
 * verification gets a sharp image.
 *
 * Prerequisite: the lease must be "ready". Returns 409 otherwise. Modeled on
 * the render route (launch-wrapper catches pre-run.py failures and writes them
 * to state.json so the canvas/agent never see a stuck "starting").
 */

export async function POST(
  req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { instanceId } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  // ── Validate instance + lease ────────────────────────────────────────────
  const instance = db()
    .prepare(
      "SELECT id, user_id, workflow_type, folder FROM workflow_instances WHERE id = ? AND user_id = ?",
    )
    .get(instanceId, user.id) as
    | { id: string; user_id: number; workflow_type: string; folder: string }
    | undefined;
  if (!instance) {
    return NextResponse.json({ error: "workflow instance not found" }, { status: 404 });
  }
  if (instance.workflow_type !== "blender") {
    return NextResponse.json(
      { error: `instance is not a blender workflow (got ${instance.workflow_type})` },
      { status: 400 },
    );
  }

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return NextResponse.json({ error: "container not ready" }, { status: 409 });
  }

  const lease = leaseManager().get(instanceId);
  if (!lease || lease.state !== "ready") {
    return NextResponse.json(
      { error: "GPU not ready", leaseState: lease?.state ?? "none" },
      { status: 409 },
    );
  }
  // Bump activity — a preview keeps the lease alive.
  leaseManager().touch(instanceId);

  // ── Coerce settings (loose — previews are cheap and agent-driven) ────────
  const settings = body.settings && typeof body.settings === "object" ? body.settings : {};
  const samples = Math.min(256, Math.max(1, Number(settings.samples ?? 16) || 16));
  const resolutionX = Math.min(2560, Math.max(160, Number(settings.resolution_x ?? 960) || 960));
  const resolutionY = Math.min(1440, Math.max(90, Number(settings.resolution_y ?? 540) || 540));

  // ── Write request.json ──────────────────────────────────────────────────
  const requestPayload = {
    op: "preview",
    settings: { samples, resolution_x: resolutionX, resolution_y: resolutionY },
    instanceId,
    folder: instance.folder,
    requestedAt: new Date().toISOString(),
  };
  const requestJson = JSON.stringify(requestPayload);
  const writeCmd = `cat > '${instance.folder}/request.json' <<'__BLENDER_REQUEST_EOF__'\n${requestJson}\n__BLENDER_REQUEST_EOF__`;
  const writeRes = await execInContainer(row, ["bash", "-lc", writeCmd], { user: "appuser" });
  if (writeRes.code !== 0) {
    return NextResponse.json(
      { error: "failed to write request.json", detail: writeRes.stderr.trim() || `exit ${writeRes.code}` },
      { status: 500 },
    );
  }

  // ── Write "starting" state immediately ──────────────────────────────────
  const startingPatch = JSON.stringify({
    phase: "starting",
    lastUpdated: new Date().toISOString(),
    errors: [],
    active: { op: "preview", label: "Starting preview…" },
  });
  const stateWriteCmd = `python3 - <<'__STATE_EOF__'
import json, os
path = ${JSON.stringify(instance.folder + "/state.json")}
state = {}
try:
    with open(path) as f: state = json.load(f)
except Exception: pass
state.update(${startingPatch})
with open(path, "w") as f: json.dump(state, f, indent=2)
__STATE_EOF__`;
  await execInContainer(row, ["bash", "-lc", stateWriteCmd], { user: "appuser" }).catch(() => {});

  // ── Launch the script (fire-and-forget) ──────────────────────────────────
  // Same wrapper pattern as the render route: writes phase:"error" + the
  // pipeline.log tail if the launch itself fails (e.g. venv/import error that
  // kills uv before run.py runs), so state.json never sticks at "starting".
  const script = "/app/blender/run.py";
  const logFile = `${instance.folder}/pipeline.log`;
  const wrapperPath = `${instance.folder}/run_preview.sh`;
  const statePath = `${instance.folder}/state.json`;
  const wrapperWriteCmd = `cat > '${wrapperPath}' <<'__WRAPPER_EOF__'
#!/usr/bin/env bash
set -uo pipefail
cd /app/blender
uv run --project /app/blender python '${script}' '${instance.folder}' --request request.json >> '${logFile}' 2>&1
rc=$?
if [ $rc -ne 0 ]; then
  python3 - '$statePath' '$logFile' <<'__PY_EOF__' || true
import json, sys, datetime
state_path, log_path = sys.argv[1], sys.argv[2]
state = {}
try:
    with open(state_path) as f: state = json.load(f)
except Exception: pass
tail = ""
try:
    with open(log_path) as f: tail = "".join(f.readlines()[-15:])
except Exception: pass
errs = ["preview launch failed (see pipeline.log)"]
if tail.strip(): errs.append(tail.strip())
state.update({"phase": "error", "lastUpdated": datetime.datetime.utcnow().isoformat(), "errors": errs, "active": None})
with open(state_path, "w") as f: json.dump(state, f, indent=2)
__PY_EOF__
fi
exit $rc
__WRAPPER_EOF__
chmod +x '${wrapperPath}'`;
  await execInContainer(row, ["bash", "-lc", wrapperWriteCmd], { user: "appuser" });
  const cmd = `nohup setsid bash '${wrapperPath}' > '${logFile}' 2>&1 &`;
  const r = await execInContainer(row, ["bash", "-lc", cmd], { user: "appuser" });
  if (r.code !== 0) {
    const errorPatch = JSON.stringify({
      phase: "error",
      lastUpdated: new Date().toISOString(),
      errors: ["failed to launch preview"],
      active: null,
    });
    const errorCmd = `python3 - <<'__STATE_EOF__'\nimport json\npath = ${JSON.stringify(statePath)}\nstate = {}\ntry:\n    with open(path) as f: state = json.load(f)\nexcept Exception: pass\nstate.update(${errorPatch})\nwith open(path, "w") as f: json.dump(state, f, indent=2)\n__STATE_EOF__`;
    await execInContainer(row, ["bash", "-lc", errorCmd], { user: "appuser" }).catch(() => {});
    return NextResponse.json(
      { error: "failed to launch preview", detail: r.stderr.trim() || `exit ${r.code}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
