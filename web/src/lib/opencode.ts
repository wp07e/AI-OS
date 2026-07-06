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
  const res = await fetch(opencodeUrl(port, `/session/${sessionId}/message`), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      parts: [{ type: "text", text }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST /session/${sessionId}/message → ${res.status}: ${body || "<no body>"}`);
  }
  return (await res.json()) as OpencodeMessageResponse;
}

/** Extracts concatenated assistant text from a message response's parts. */
export function extractAssistantText(res: OpencodeMessageResponse): string {
  return res.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();
}

// ─── Per-user session caching ───────────────────────────────────────────────

interface CachedSession {
  user_id: number;
  session_id: string;
  opencode_port: number;
}

/** Returns a usable opencode session id for the user, creating + caching if needed. */
export async function getOrCreateSession(row: ContainerRow): Promise<string> {
  const cached = db()
    .prepare("SELECT * FROM opencode_sessions WHERE user_id = ?")
    .get(row.user_id) as CachedSession | undefined;

  // Reuse if the cached session is on the same port (i.e. same container).
  if (cached && cached.opencode_port === row.opencode_port) {
    return cached.session_id;
  }

  const sessionId = await createSession(row.opencode_port);
  db()
    .prepare(
      `INSERT INTO opencode_sessions (user_id, session_id, opencode_port, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         session_id = excluded.session_id,
         opencode_port = excluded.opencode_port,
         created_at = excluded.created_at`,
    )
    .run(row.user_id, sessionId, row.opencode_port, Date.now());
  return sessionId;
}

/** Clears the cached session (e.g. if the server rejects it). Forces a fresh one next call. */
export function invalidateSession(userId: number): void {
  db().prepare("DELETE FROM opencode_sessions WHERE user_id = ?").run(userId);
}
