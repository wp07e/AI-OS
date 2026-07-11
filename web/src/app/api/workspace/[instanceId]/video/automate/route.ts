import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { execInContainer, getContainerForUser } from "@/lib/docker";
import { promptAsync, getOrCreateSession, type SessionPrime } from "@/lib/opencode";
import { getWorkflow } from "@/lib/workflows/registry";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/workspace/<instanceId>/video/automate
 *
 * Writes automation_request.json into the instance folder, then sends a chat
 * message to the agent to trigger the automation workflow. The agent will:
 *   1. Read automation_request.json
 *   2. Analyze assigned assets using grok.chat_with_vision
 *   3. Write storyboard.json
 *   4. Run the deterministic script with op: "automate"
 *
 * The message route prepends buildAutomationPrefill() to the agent's message
 * (same pattern as brand prefill), so the agent gets full context on subsequent
 * messages. For the initial trigger, the message itself contains the summary.
 *
 * This route is fire-and-forget: it writes the request file, fires the chat
 * message via prompt_async (returns 204), and returns { ok: true }. The agent
 * processes asynchronously and the canvas polls state.json for progress.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { instanceId } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  // ── Validate + sanitize ─────────────────────────────────────────────────
  const clipCount = Math.min(10, Math.max(1, Number(body.clipCount) || 3));
  const clipDuration = Math.min(15, Math.max(1, Number(body.clipDuration) || 6));
  const resolution = ["480p", "720p", "1080p"].includes(body.resolution) ? body.resolution : "720p";
  const quality = body.quality === "high" ? "high" : "low";
  const aspectRatio = ["16:9", "9:16", "1:1"].includes(body.aspectRatio) ? body.aspectRatio : "16:9";
  const baseStory = typeof body.baseStory === "string" ? body.baseStory.slice(0, 2000) : "";
  const clips = Array.isArray(body.clips) ? body.clips : [];

  // Sanitize per-clip config — same ref sanitization as the generate route.
  const isSafeBrandRef = (r: string) => typeof r === "string" && /^[a-zA-Z0-9_-]+$/.test(r);
  const isSafeUploadRef = (r: string) =>
    typeof r === "string" && /^uploads\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp|gif)$/i.test(r);

  const safeClips = clips.slice(0, clipCount).map((c: Record<string, unknown>, i: number) => ({
    index: i,
    continuity: c?.continuity === "last_frame" ? "last_frame" : "none",
    assetMode: ["brand", "ai", "upload"].includes(c?.assetMode as string) ? c.assetMode : "brand",
    brandAssets: Array.isArray(c?.brandAssets)
      ? (c.brandAssets as unknown[]).filter(isSafeBrandRef as (r: unknown) => r is string)
      : [],
    uploadedAssets: Array.isArray(c?.uploadedAssets)
      ? (c.uploadedAssets as unknown[]).filter(isSafeUploadRef as (r: unknown) => r is string)
      : [],
    promptHint: typeof c?.promptHint === "string" ? c.promptHint.slice(0, 500) : "",
  }));

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

  // ── Write automation_request.json ───────────────────────────────────────
  // Write via a heredoc so JSON quoting is safe (no shell interpolation),
  // matching the generate route's pattern.
  const requestPayload = {
    op: "automate",
    clipCount,
    clipDuration,
    resolution,
    quality,
    aspectRatio,
    baseStory,
    clips: safeClips,
    folder: instance.folder,
    requestedAt: new Date().toISOString(),
  };
  const requestJson = JSON.stringify(requestPayload);
  const writeCmd = `cat > '${instance.folder}/automation_request.json' <<'__AUTOMATION_EOF__'\n${requestJson}\n__AUTOMATION_EOF__`;
  const writeRes = await execInContainer(row, ["bash", "-lc", writeCmd], { user: "appuser" });
  if (writeRes.code !== 0) {
    return NextResponse.json(
      { error: "failed to write automation_request.json", detail: writeRes.stderr.trim() || `exit ${writeRes.code}` },
      { status: 500 },
    );
  }

  // ── Write "starting" state immediately ──────────────────────────────────
  // The automation has a long startup gap: the agent must analyze assets with
  // vision, write storyboard.json, and launch the script before any state
  // changes. We write "starting" here so the canvas disables chat + form
  // within the next 2.5s poll. The script will overwrite this with "automating"
  // when _do_automate begins.
  const startingState = JSON.stringify({
    phase: "starting",
    lastUpdated: new Date().toISOString(),
    errors: [],
    active: { op: "automate", label: "Analyzing assets…" },
  });
  const stateWriteCmd = `python3 -c "
import json, os
path = '${instance.folder}/state.json'
state = {}
try:
    with open(path) as f: state = json.load(f)
except: pass
state.update(json.loads('''${startingState.replace(/'/g, "\\'")}'''))
with open(path, 'w') as f: json.dump(state, f, indent=2)
"`;
  await execInContainer(row, ["bash", "-lc", stateWriteCmd], { user: "appuser" }).catch(() => {});

  // ── Send the chat message to trigger the agent ──────────────────────────
  // The message route will prepend buildAutomationPrefill() when it detects
  // automation_request.json in the folder. We fire prompt_async directly
  // (returns 204) — the agent processes asynchronously.
  const message = `Run video automation: ${clipCount} clips, ${clipDuration}s each, ${resolution} ${quality} quality, ${aspectRatio}.${baseStory ? ` Story: "${baseStory.slice(0, 100)}"` : ""} Read automation_request.json in this folder, analyze the assigned assets, write storyboard.json, then run the video script.`;

  const def = getWorkflow("video");
  const prime: SessionPrime = {
    folder: instance.folder,
    skill: def?.skill ?? "video",
    sessionPrompt: def?.sessionPrompt,
  };

  try {
    const sessionId = await getOrCreateSession(row, instanceId, prime);
    await promptAsync(row.opencode_port, sessionId, message);
  } catch (e) {
    return NextResponse.json(
      { error: "failed to trigger agent", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
