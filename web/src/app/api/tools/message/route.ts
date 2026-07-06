import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getContainerForUser } from "@/lib/docker";
import {
  extractAssistantText,
  getOrCreateSession,
  invalidateSession,
  sendMessage,
} from "@/lib/opencode";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Sends the user's message to their per-container opencode server using the
 * real HTTP API (https://opencode.ai/docs/server/):
 *   1. Get-or-create an opencode session (cached per user in opencode_sessions).
 *   2. POST /session/:id/message with { parts: [{ type: "text", text }] }.
 *   3. Concatenate assistant text parts and return to the browser.
 *
 * If the cached session is rejected (404), we invalidate and retry once.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return NextResponse.json({ error: "container not ready" }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  try {
    let sessionId = await getOrCreateSession(row);
    try {
      const res = await sendMessage(row.opencode_port, sessionId, message);
      return NextResponse.json({
        ok: true,
        text: extractAssistantText(res),
        sessionId,
        raw: res,
      });
    } catch (err) {
      // If the session was rejected (server restarted, eviction, etc.), retry once.
      if (isNotFound(err)) {
        invalidateSession(user.id);
        sessionId = await getOrCreateSession(row);
        const res = await sendMessage(row.opencode_port, sessionId, message);
        return NextResponse.json({
          ok: true,
          text: extractAssistantText(res),
          sessionId,
          raw: res,
        });
      }
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "opencode request failed", detail: message },
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
