import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getContainerForUser } from "@/lib/docker";
import { db } from "@/lib/db";
import {
  extractAssistantText,
  getOrCreateSession,
  invalidateSession,
  sendMessage,
} from "@/lib/opencode";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * DEBUG: every stage is timed and logged to server console. Look for lines
 * tagged `[msg]` in the `next dev` / `next-server` terminal output. This is
 * intentionally verbose while we isolate the hang/timeout.
 */
function log(stage: string, fields?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const body = fields ? " " + JSON.stringify(fields) : "";
  console.log(`[msg] ${ts} ${stage}${body}`);
}

/**
 * Sends the user's message to their per-container opencode server.
 * See docs/superpowers/specs/2026-07-07-ai-os-shell-design.md §1.6.
 */
export async function POST(req: Request) {
  const t0 = Date.now();
  log("POST /api/tools/message — start");

  const user = await currentUser();
  if (!user) {
    log("reject — no user");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  log("auth ok", { userId: user.id, username: user.username });

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    log("reject — container not ready", { container: row ? { status: row.status, port: row.opencode_port } : null });
    return NextResponse.json({ error: "container not ready" }, { status: 409 });
  }
  log("container ready", { port: row.opencode_port, project: row.project_name });

  const body = await req.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  if (!message) {
    log("reject — empty message");
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const workflowInstanceId = String(body.workflowInstanceId ?? "").trim();
  if (!workflowInstanceId) {
    log("reject — no workflowInstanceId");
    return NextResponse.json({ error: "workflowInstanceId is required" }, { status: 400 });
  }

  const instance = db()
    .prepare(
      "SELECT id, workflow_type, title, folder FROM workflow_instances WHERE id = ? AND user_id = ?",
    )
    .get(workflowInstanceId, user.id) as
    | { id: string; workflow_type: string; title: string; folder: string }
    | undefined;
  if (!instance) {
    log("reject — instance not found", { workflowInstanceId });
    return NextResponse.json({ error: "workflow instance not found" }, { status: 404 });
  }
  log("instance resolved", { type: instance.workflow_type, folder: instance.folder });

  const opencodeUrl = `http://127.0.0.1:${row.opencode_port}`;
  try {
    log("getOrCreateSession — start");
    const tSession = Date.now();
    let sessionId = await getOrCreateSession(row, workflowInstanceId);
    log("getOrCreateSession — done", { sessionId, ms: Date.now() - tSession });

    // The user's message is forwarded to OpenCode CLEAN — no prefix, no grounding
    // preamble. We learned (the hard way) that ANY folder/path reference in the
    // message triggers OpenCode's agent tool loops (it stats/accesses the path,
    // loads skills, etc.), which take minutes with a reasoning model. The agent
    // already runs from /workspace; when it needs the instance folder for real
    // file work, the user or the skill tells it. Grounding happens via the skill
    // procedure, not via message injection.
    try {
      log("sendMessage attempt 1 — start", {
        url: `${opencodeUrl}/session/${sessionId}/message`,
        messagePreview: message.slice(0, 80),
        messageLen: message.length,
      });
      const tSend = Date.now();
      const res = await sendMessage(row.opencode_port, sessionId, message);
      log("sendMessage attempt 1 — done", {
        ms: Date.now() - tSend,
        partsCount: res.parts?.length ?? 0,
        partTypes: res.parts?.map((p) => p.type) ?? [],
        hasError: Boolean((res.info as Record<string, unknown> | null)?.error),
      });

      const text = extractAssistantText(res);
      log("response text extracted", { textLen: text.length, textPreview: text.slice(0, 100) });
      log("POST — ok", { totalMs: Date.now() - t0 });
      return NextResponse.json({ ok: true, text, sessionId, raw: res });
    } catch (err) {
      log("sendMessage attempt 1 — ERROR", {
        msSinceSendStart: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
        errorName: err instanceof Error ? err.name : typeof err,
      });

      // If the session was rejected (404), invalidate and retry once.
      if (isNotFound(err)) {
        log("session rejected (404) — invalidating + retrying");
        invalidateSession(user.id, workflowInstanceId);
        const tSession2 = Date.now();
        sessionId = await getOrCreateSession(row, workflowInstanceId);
        log("getOrCreateSession (retry) — done", { sessionId, ms: Date.now() - tSession2 });

        log("sendMessage attempt 2 — start");
        const tSend2 = Date.now();
        const res = await sendMessage(row.opencode_port, sessionId, message);
        log("sendMessage attempt 2 — done", { ms: Date.now() - tSend2 });

        const text = extractAssistantText(res);
        log("POST — ok (after retry)", { totalMs: Date.now() - t0 });
        return NextResponse.json({ ok: true, text, sessionId, raw: res });
      }
      throw err;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log("POST — FAIL (502)", { totalMs: Date.now() - t0, detail });
    return NextResponse.json(
      { error: "opencode request failed", detail },
      { status: 502 },
    );
  }
}

function isNotFound(err: unknown): boolean {
  if (err instanceof Error) {
    return /→ 404/.test(err.message) || /not found/i.test(err.message);
  }
  return false;
}
