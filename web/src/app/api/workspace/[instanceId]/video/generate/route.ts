import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { execInContainer, getContainerForUser } from "@/lib/docker";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/workspace/<instanceId>/video/generate
 * Body: the GenerateRequest shape (op, prompt, quality, settings, references,
 * sourceClipIndex, seedPrompt, startImageExport, continuity, clipIndices).
 *
 * Fire-and-forget: writes request.json into the instance folder and launches the
 * deterministic video script (container/video/run.py) under nohup. The canvas
 * polls state.json for the phase transition and result. Modeled on the carousel
 * select-candidate resume route.
 *
 * Provider/model/ffmpeg-agnostic: this route never names Grok, a model, or
 * ffmpeg — it just forwards the request to the script, which owns all provider
 * selection. Adding a future video MCP = script change only.
 *
 * The script runs as appuser (uid 2000) so it can read brand_selection.json and
 * the brand assets, and write exports/.
 */
const ALLOWED_OPS = new Set([
  "generate_video",
  "extend_video",
  "generate_image",
  "edit_image",
  "assemble",
  "extract_frame",
  "delete_clip",
  "toggle_include",
]);

export async function POST(
  req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { instanceId } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  // ── Validate ────────────────────────────────────────────────────────────
  const op = String(body.op ?? "").trim();
  if (!ALLOWED_OPS.has(op)) {
    return NextResponse.json({ error: `invalid op: ${op}` }, { status: 400 });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const quality = body.quality === "high" ? "high" : "low";
  const references = Array.isArray(body.references)
    ? body.references.filter((r: unknown): r is string => typeof r === "string")
    : [];
  // Defensive: sanitize the references. Two valid formats:
  //   1. Brand asset ids (uuids: hex + dash): [a-zA-Z0-9_-]+
  //   2. Instance upload paths: uploads/<hex>.<ext>
  const isSafeRef = (r: string) =>
    /^[a-zA-Z0-9_-]+$/.test(r) ||
    /^uploads\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp|gif)$/i.test(r);
  const safeRefs = references.filter(isSafeRef);
  if (safeRefs.length !== references.length) {
    return NextResponse.json({ error: "invalid reference id or path" }, { status: 400 });
  }

  const settings =
    body.settings && typeof body.settings === "object" ? body.settings : {};
  const sourceClipIndex =
    typeof body.sourceClipIndex === "number" ? body.sourceClipIndex : undefined;
  const seedPrompt =
    typeof body.seedPrompt === "string" ? body.seedPrompt : undefined;
  const startImageExport =
    typeof body.startImageExport === "string" &&
    /^[\w./-]+\.(png|jpe?g|webp)$/i.test(body.startImageExport)
      ? body.startImageExport
      : undefined;
  const continuity =
    body.continuity === "extend" || body.continuity === "last_frame"
      ? body.continuity
      : "none";
  const clipIndices = Array.isArray(body.clipIndices)
    ? body.clipIndices.filter((n: unknown): n is number => typeof n === "number")
    : undefined;

  // ── Resolve instance + container ────────────────────────────────────────
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
  if (instance.workflow_type !== "video") {
    return NextResponse.json(
      { error: `instance is not a video workflow (got ${instance.workflow_type})` },
      { status: 400 },
    );
  }

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return NextResponse.json({ error: "container not ready" }, { status: 409 });
  }

  // ── Write request.json ──────────────────────────────────────────────────
  const included = typeof body.included === "boolean" ? body.included : undefined;
  const requestPayload = {
    op,
    prompt,
    quality,
    settings,
    references: safeRefs,
    sourceClipIndex,
    seedPrompt,
    startImageExport,
    continuity,
    clipIndices,
    included,
    instanceId,
    folder: instance.folder,
    requestedAt: new Date().toISOString(),
  };
  const requestJson = JSON.stringify(requestPayload);
  // Write via a heredoc so JSON quoting is safe (no shell interpolation).
  const writeCmd = `cat > '${instance.folder}/request.json' <<'__VIDEO_REQUEST_EOF__'\n${requestJson}\n__VIDEO_REQUEST_EOF__`;
  const writeRes = await execInContainer(row, ["bash", "-lc", writeCmd], { user: "appuser" });
  if (writeRes.code !== 0) {
    return NextResponse.json(
      { error: "failed to write request.json", detail: writeRes.stderr.trim() || `exit ${writeRes.code}` },
      { status: 500 },
    );
  }

  // ── Write "starting" state immediately ──────────────────────────────────
  // The script takes several seconds to start (uv run cold start + Python
  // imports + GrokClient init). During that gap, state.json still reads the
  // prior phase, so the UI shows no feedback and chat stays enabled. We write
  // a "starting" phase here so the canvas disables chat + form within the next
  // 2.5s poll. The script will overwrite this with "preparing" when it enters
  // the op handler.
  //
  // Uses a heredoc to write state.json (same safe pattern as request.json
  // above). We merge with any existing state via a small python3 script so
  // we don't clobber clips[] or other fields.
  const startingPatch = JSON.stringify({
    phase: "starting",
    lastUpdated: new Date().toISOString(),
    errors: [],
    active: { op, label: "Starting…" },
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

  // ── Launch the script (fire-and-forget) ─────────────────────────────────
  // `--project /app/video` tells uv to resolve deps from that dir's pyproject
  // (xai-sdk, httpx). The script itself takes the instance folder + request.
  const script = "/app/video/run.py";
  const logFile = `${instance.folder}/pipeline.log`;
  const cmd = `cd /app/video && nohup uv run --project /app/video python ${script} '${instance.folder}' --request request.json > '${logFile}' 2>&1 &`;
  const r = await execInContainer(row, ["bash", "-lc", cmd], { user: "appuser" });
  // execInContainer returns when the spawned `bash -lc` exits; the nohup'd
  // child keeps running. A non-zero code here means the launch itself failed.
  if (r.code !== 0) {
    return NextResponse.json(
      { error: "failed to launch generation", detail: r.stderr.trim() || `exit ${r.code}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
