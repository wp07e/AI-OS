import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getContainerForUser } from "@/lib/docker";
import { db } from "@/lib/db";
import {
  abortSession,
  getCachedLibrarySession,
  getCachedWorkflowSession,
} from "@/lib/opencode";

export const runtime = "nodejs";

/**
 * Best-effort interrupt of the active chat turn. Mirrors the auth +
 * container-ready + transport-resolution shape of the message route, but
 * resolves the session id READ-ONLY (no create, no prime) and fires OpenCode's
 * `POST /session/:id/abort`.
 *
 * Always returns `{ ok: true }`. The client has already unlocked its UI by the
 * time this returns; this call exists to stop the server-side agent so it
 * doesn't keep burning tokens after the user stopped/steered. If there's no
 * cached session (nothing in flight) or the endpoint is unavailable, that's a
 * benign no-op.
 *
 * Body: same targeting as /api/tools/message — `{ workflowInstanceId }` OR
 * `{ library }`. Auth + container checks identical to the message route.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return NextResponse.json({ error: "container not ready" }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const library = String(body.library ?? "").trim();
  const workflowInstanceId = String(body.workflowInstanceId ?? "").trim();

  // Resolve the session id WITHOUT creating/priming. If there's no cached,
  // container-matching session, there's nothing in flight to abort.
  let sessionId: string | null = null;
  if (library) {
    sessionId = getCachedLibrarySession(user.id, library, row);
  } else if (workflowInstanceId) {
    // Validate ownership (mirror the message route) before resolving.
    const instance = db()
      .prepare("SELECT 1 FROM workflow_instances WHERE id = ? AND user_id = ?")
      .get(workflowInstanceId, user.id);
    if (instance) {
      sessionId = getCachedWorkflowSession(user.id, workflowInstanceId, row);
    }
  }

  if (!sessionId) {
    return NextResponse.json({ ok: true, note: "no active session" });
  }

  await abortSession(row.opencode_port, sessionId);
  return NextResponse.json({ ok: true });
}
