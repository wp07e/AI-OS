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
  const script = "/app/blender/run.py";
  const logFile = `${instance.folder}/pipeline.log`;
  const cmd = `cd /app/blender && nohup uv run --project /app/blender python ${script} '${instance.folder}' --request request.json > '${logFile}' 2>&1 &`;
  const r = await execInContainer(row, ["bash", "-lc", cmd], { user: "appuser" });
  if (r.code !== 0) {
    // Reset state.json from "starting" → "error" so the canvas doesn't hang.
    const errorPatch = JSON.stringify({
      phase: "error",
      lastUpdated: new Date().toISOString(),
      errors: ["failed to launch render script"],
      active: null,
    });
    const errorCmd = `python3 - <<'__STATE_EOF__'\nimport json\npath = ${JSON.stringify(instance.folder + "/state.json")}\nstate = {}\ntry:\n    with open(path) as f: state = json.load(f)\nexcept Exception: pass\nstate.update(${errorPatch})\nwith open(path, "w") as f: json.dump(state, f, indent=2)\n__STATE_EOF__`;
    await execInContainer(row, ["bash", "-lc", errorCmd], { user: "appuser" }).catch(() => {});
    return NextResponse.json(
      { error: "failed to launch render", detail: r.stderr.trim() || `exit ${r.code}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
