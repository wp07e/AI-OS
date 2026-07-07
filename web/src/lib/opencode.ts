import { db, type ContainerRow } from "./db";

// ─── opencode HTTP client ───────────────────────────────────────────────────
// Spec: https://opencode.ai/docs/server/
// Key endpoints:
//   GET  /global/health            → { healthy, version }
//   POST /session                  → Session { id, ... }
//   POST /session/:id/message      → { info, parts: [{ type, ... }] }
// Auth (optional): OPENCODE_SERVER_PASSWORD → HTTP Basic, user "opencode".

const authHeader = (): string | undefined => {
  const pwd = process.env.OPENCODE_SERVER_PASSWORD;
  return pwd ? "Basic " + Buffer.from(`opencode:${pwd}`).toString("base64") : undefined;
};

const headers = (): Record<string, string> => {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const auth = authHeader();
  if (auth) h.Authorization = auth;
  return h;
};

export function opencodeUrl(port: number, path = ""): string {
  return `http://127.0.0.1:${port}${path}`;
}

/** True when the opencode server reports itself healthy. */
export async function isOpencodeReady(port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(opencodeUrl(port, "/global/health"), {
      signal: ctrl.signal,
      headers: headers(),
    });
    clearTimeout(t);
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { healthy?: boolean } | null;
    return data?.healthy === true;
  } catch {
    return false;
  }
}

interface OpencodeSession {
  id: string;
  [k: string]: unknown;
}

/** Creates a new opencode session. Returns the session id. */
export async function createSession(port: number): Promise<string> {
  const res = await fetch(opencodeUrl(port, "/session"), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /session → ${res.status}: ${text || "<no body>"}`);
  }
  const session = (await res.json()) as OpencodeSession;
  if (!session?.id) throw new Error("/session response missing id");
  return session.id;
}

export interface OpencodeTextPart {
  type: "text";
  text: string;
}
export interface OpencodeMessageResponse {
  info: unknown;
  parts: Array<Record<string, unknown>>;
}

/** Sends a user message and returns the raw { info, parts } response. */
export async function sendMessage(
  port: number,
  sessionId: string,
  text: string,
): Promise<OpencodeMessageResponse> {
  const url = opencodeUrl(port, `/session/${sessionId}/message`);
  const t0 = Date.now();
  console.log(`[opencode] POST ${url} — fetch start (text ${text.length} chars)`);
  const res = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      parts: [{ type: "text", text }],
    }),
  });
  const fetchMs = Date.now() - t0;
  console.log(`[opencode] POST ${url} — response ${res.status} after ${fetchMs}ms`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[opencode] POST ${url} — non-OK body:`, body.slice(0, 500));
    throw new Error(`POST /session/${sessionId}/message → ${res.status}: ${body || "<no body>"}`);
  }
  const jsonStart = Date.now();
  const parsed = (await res.json()) as OpencodeMessageResponse;
  console.log(`[opencode] POST ${url} — json parsed in ${Date.now() - jsonStart}ms, ${parsed.parts?.length ?? 0} parts`);
  return parsed;
}

/** Extracts concatenated assistant text from a message response's parts. */
export function extractAssistantText(res: OpencodeMessageResponse): string {
  return res.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();
}

// ─── Per-(user, workflow_instance) session caching ──────────────────────────
//
// One OpenCode process per user container serves many sessions on a single
// port. Each workflow instance (lane) gets its own opencode session id, cached
// here so multi-turn conversations persist across requests. The cache is
// mirrored on opencode_port so a container relaunch (new port) invalidates it.
//
// IMPORTANT: OpenCode serializes message processing per session. Two concurrent
// fetches to /session/:id/message on the same session will queue — the second
// waits for the first to complete. So we NEVER fire-and-forget a "prime"
// message alongside the real one. Workflow context is grounded by the ROUTE
// caller (it constructs a grounded first message), not by this function.

interface CachedSession {
  user_id: number;
  workflow_instance_id: string;
  session_id: string;
  opencode_port: number;
}

/**
 * Returns a usable opencode session id for the given workflow instance, creating
 * + caching one if needed. Reuses the cached session only if it's on the same
 * port (i.e. the same container). Does NOT prime — see note above.
 */
export async function getOrCreateSession(
  row: ContainerRow,
  workflowInstanceId: string,
): Promise<string> {
  const cached = db()
    .prepare("SELECT * FROM opencode_sessions WHERE user_id = ? AND workflow_instance_id = ?")
    .get(row.user_id, workflowInstanceId) as CachedSession | undefined;

  if (cached && cached.opencode_port === row.opencode_port) {
    return cached.session_id;
  }

  const sessionId = await createSession(row.opencode_port);
  db()
    .prepare(
      `INSERT INTO opencode_sessions (user_id, workflow_instance_id, session_id, opencode_port, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, workflow_instance_id) DO UPDATE SET
         session_id = excluded.session_id,
         opencode_port = excluded.opencode_port,
         created_at = excluded.created_at`,
    )
    .run(row.user_id, workflowInstanceId, sessionId, row.opencode_port, Date.now());

  return sessionId;
}

/** Clears the cached session for a workflow instance (e.g. if the server rejects it). */
export function invalidateSession(userId: number, workflowInstanceId: string): void {
  db()
    .prepare("DELETE FROM opencode_sessions WHERE user_id = ? AND workflow_instance_id = ?")
    .run(userId, workflowInstanceId);
}
