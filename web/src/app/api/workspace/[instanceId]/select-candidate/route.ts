import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { execInContainer, getContainerForUser } from "@/lib/docker";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/workspace/<instanceId>/select-candidate
 * Body: { candidateId: string }
 *
 * Deck mode resume: the user picked a candidate deck in the canvas. This route
 * re-invokes the deterministic pipeline with --selected-candidate <id>, which
 * runs create-design-from-candidate → export → state.json. Fire-and-forget: we
 * return immediately and let the canvas keep polling state.json for the
 * phase transition out of awaiting_candidate_selection.
 *
 * The script runs as appuser (uid 2000) so it can read the Canva token cache.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { instanceId } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const candidateId = String(body.candidateId ?? "").trim();
  if (!candidateId) {
    return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  }

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

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return NextResponse.json({ error: "container not ready" }, { status: 409 });
  }

  // ── Write "starting" state immediately ──────────────────────────────────
  // The carousel script takes several seconds to start (uv run cold start +
  // Python imports + Canva MCP client init). During that gap, state.json still
  // reads the prior phase (awaiting_candidate_selection), so the UI shows no
  // feedback. We write a "starting" phase so the canvas + chat disable within
  // the next 2.5s poll. The script overwrites this when it enters its handler.
  const startingPatch = JSON.stringify({
    phase: "starting",
    lastUpdated: new Date().toISOString(),
    errors: [],
    active: { op: "resume", label: "Resuming…" },
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

  // Fire-and-forget the resume run. We don't await it — the canvas polls
  // state.json for the phase transition. Use nohup + disown so the exec doesn't
  // tie up the request, and redirect output to a log under the instance folder.
  const script = "/app/carousel/run.py";
  const logFile = `${instance.folder}/pipeline.log`;
  // Validate candidateId is a plausible dg-... id (defensive — it's interpolated
  // into a shell command). Restrict to alphanumerics + dash.
  const safe = candidateId.replace(/[^a-zA-Z0-9-]/g, "");
  if (safe !== candidateId) {
    return NextResponse.json({ error: "invalid candidateId" }, { status: 400 });
  }
  const cmd = `nohup uv run python ${script} '${instance.folder}' --selected-candidate '${safe}' > '${logFile}' 2>&1 &`;
  const r = await execInContainer(row, ["bash", "-lc", cmd], { user: "appuser" });
  // execInContainer returns when the spawned `bash -lc` exits; the nohup'd
  // child keeps running. A non-zero code here means the launch itself failed
  // (not the pipeline).
  if (r.code !== 0) {
    return NextResponse.json(
      { error: "failed to launch resume", detail: r.stderr.trim() || `exit ${r.code}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
