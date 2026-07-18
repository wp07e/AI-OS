import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { execInContainer, getContainerForUser } from "@/lib/docker";
import { leaseManager } from "@/lib/gpu/lease-manager";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/workspace/<instanceId>/blender/render
 * Body: { settings: { engine, samples, resolution, frame_start, frame_end } }
 *
 * Fire-and-forget: writes request.json into the instance folder and launches
 * the deterministic Blender render script (container/blender/run.py) under
 * nohup. The canvas polls state.json for the phase transition and result.
 * Modeled on the video generate route.
 *
 * Prerequisite: the lease must be "ready" (the lane-open POST acquires it
 * automatically). Returns 409 if the GPU isn't ready yet.
 */
const ALLOWED_ENGINES = new Set(["CYCLES", "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"]);
const ALLOWED_RESOLUTIONS = new Set(["720p", "1080p", "1440p", "4k"]);
const ALLOWED_SAMPLES = new Set([64, 128, 256, 512, 1024]);

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
  // Bump activity — a render keeps the lease alive.
  leaseManager().touch(instanceId);

  // ── Validate settings ────────────────────────────────────────────────────
  const settings = body.settings && typeof body.settings === "object" ? body.settings : {};
  const engine = ALLOWED_ENGINES.has(String(settings.engine)) ? String(settings.engine) : "CYCLES";
  const samples = ALLOWED_SAMPLES.has(Number(settings.samples)) ? Number(settings.samples) : 128;
  const resolution = ALLOWED_RESOLUTIONS.has(String(settings.resolution))
    ? String(settings.resolution)
    : "1080p";
  const frameStart = Math.max(1, Number(settings.frame_start ?? 1) || 1);
  const frameEnd = Math.max(frameStart, Number(settings.frame_end ?? frameStart) || frameStart);

  // ── Write request.json ──────────────────────────────────────────────────
  const requestPayload = {
    op: "render",
    settings: { engine, samples, resolution, frame_start: frameStart, frame_end: frameEnd },
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

  // ── Write "starting" state immediately (gap-bridge, like video) ──────────
  const startingPatch = JSON.stringify({
    phase: "starting",
    lastUpdated: new Date().toISOString(),
    errors: [],
    active: { op: "render", label: "Starting render…" },
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
  // The script runs detached. Because it's backgrounded, the outer `bash -lc`
  // returns 0 immediately — the route can't see the inner process's exit code.
  // To avoid a silent hang (state.json stuck at "starting" forever when the
  // launch itself fails, e.g. venv/permission errors that kill `uv run` before
  // run.py ever writes state), we write a tiny wrapper script to the instance
  // folder, then run it backgrounded. The wrapper runs the real command and,
  // on non-zero exit, writes phase:"error" + the pipeline.log tail to
  // state.json so the canvas and the agent both see the failure. (run.py
  // writes its own errors on in-pipeline failures; this wrapper only fires for
  // pre-run.py failures like the venv/permission case.)
  const script = "/app/blender/run.py";
  const logFile = `${instance.folder}/pipeline.log`;
  const wrapperPath = `${instance.folder}/run_render.sh`;
  const statePath = `${instance.folder}/state.json`;
  // Heredoc-written wrapper avoids nested-quote escaping. `$@` passes the
  // instance folder + request args through to run.py.
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
errs = ["render launch failed (see pipeline.log)"]
if tail.strip(): errs.append(tail.strip())
state.update({"phase": "error", "lastUpdated": datetime.datetime.utcnow().isoformat(), "errors": errs, "active": None})
with open(state_path, "w") as f: json.dump(state, f, indent=2)
__PY_EOF__
fi
exit $rc
__WRAPPER_EOF__
chmod +x '${wrapperPath}'`;
  await execInContainer(row, ["bash", "-lc", wrapperWriteCmd], { user: "appuser" });
  // Background the wrapper (nohup + setsid so it survives the route returning).
  const cmd = `nohup setsid bash '${wrapperPath}' > '${logFile}' 2>&1 &`;
  const r = await execInContainer(row, ["bash", "-lc", cmd], { user: "appuser" });
  if (r.code !== 0) {
    // The outer launch itself was rejected (rare — e.g. container not
    // responding). Reset state.json from "starting" → "error" synchronously.
    const errorPatch = JSON.stringify({
      phase: "error",
      lastUpdated: new Date().toISOString(),
      errors: ["failed to launch render script"],
      active: null,
    });
    const errorCmd = `python3 - <<'__STATE_EOF__'\nimport json\npath = ${JSON.stringify(statePath)}\nstate = {}\ntry:\n    with open(path) as f: state = json.load(f)\nexcept Exception: pass\nstate.update(${errorPatch})\nwith open(path, "w") as f: json.dump(state, f, indent=2)\n__STATE_EOF__`;
    await execInContainer(row, ["bash", "-lc", errorCmd], { user: "appuser" }).catch(() => {});
    return NextResponse.json(
      { error: "failed to launch render", detail: r.stderr.trim() || `exit ${r.code}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
