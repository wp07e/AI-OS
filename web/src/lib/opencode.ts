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

/** Sends a user message and returns the raw { info, parts } response.
 *
 * BLOCKING — holds the connection until the agent finishes the whole turn. Left
 * here as a fallback; the streaming message route uses `promptAsync` +
 * `subscribeEvents` instead to avoid TCP idle timeouts on long generations.
 */
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

/**
 * Fire-and-forget prompt. Same body as /message but returns 204 immediately —
 * the agent runs asynchronously and emits progress via the /event SSE stream.
 * The streaming message route uses this so long generations don't hold a single
 * blocking fetch open (which was timing out at ~5min).
 *
 * Throws if the response isn't 2xx (a 404 means the session id is stale).
 */
export async function promptAsync(
  port: number,
  sessionId: string,
  text: string,
): Promise<void> {
  const url = opencodeUrl(port, `/session/${sessionId}/prompt_async`);
  const res = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST /session/${sessionId}/prompt_async → ${res.status}: ${body || "<no body>"}`);
  }
  // 204 No Content — nothing to parse.
}

/**
 * Raw event shape on the /event SSE stream. Every frame is `{id,type,properties}`;
 * the meaningful discriminator is `type`. The SSE `event:` field is always
 * "message" — dispatch on this `type`, not on the SSE event name.
 */
export interface OpencodeEvent {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

/**
 * Subscribes to OpenCode's global /event SSE stream and invokes `onEvent` for
 * each frame. Returns a `stop()` closure (also called automatically on stream
 * end or abort). `signal`, if provided, aborts the underlying fetch.
 *
 * Per-request lifetime: the caller subscribes, drives one prompt to completion,
 * then stops. Reconnect logic is intentionally omitted (not needed here).
 */
export function subscribeEvents(
  port: number,
  onEvent: (event: OpencodeEvent) => void,
  signal?: AbortSignal,
): () => void {
  const url = opencodeUrl(port, "/event");
  const controller = new AbortController();
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      controller.abort();
    } catch {
      /* already aborted */
    }
  };

  (async () => {
    try {
      const res = await fetch(url, {
        headers: { ...headers(), Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`GET /event → ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // SSE frames are `data: <json>\n\n`. Buffer until we have a complete frame.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // `:` comment lines (heartbeats) are valid SSE keepalives — ignore them.
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const jsonStr = line.slice("data:".length).trim();
          if (!jsonStr) continue;
          try {
            const evt = JSON.parse(jsonStr) as OpencodeEvent;
            if (evt && typeof evt.type === "string") onEvent(evt);
          } catch {
            /* malformed frame — skip, the stream is still usable */
          }
        }
      }
    } catch {
      // Aborts (normal stop) and network drops both land here; nothing to do.
    } finally {
      stop();
    }
  })();

  return stop;
}

/** Lists messages in a session (newest handling first). Used after `session.idle`
 *  to fetch the authoritative final assistant text — guards against missed SSE
 *  events if the subscription connected slightly late. */
export async function listMessages(
  port: number,
  sessionId: string,
): Promise<{ info: { role?: string }; parts: Array<Record<string, unknown>> }[]> {
  const url = opencodeUrl(port, `/session/${sessionId}/message`);
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    throw new Error(`GET /session/${sessionId}/message → ${res.status}`);
  }
  const data = (await res.json()) as { info?: { role?: string }; parts?: unknown[] }[];
  return data.map((m) => ({ info: m.info ?? {}, parts: (m.parts ?? []) as Array<Record<string, unknown>> }));
}

/** True if an OpenCode error indicates the session id is stale (should invalidate + retry). */
export function isStaleSessionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /→ 404/.test(err.message) || /not found/i.test(err.message);
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
// PRIMING: when a session is created (cache miss), one grounding message is
// sent SYNCHRONOUSLY before this function returns — telling the agent its
// concrete instance folder, its skill, and that it must operate autonomously
// end-to-end. This is distinct from the earlier anti-pattern (fire-and-forget
// primes that raced the real message): the prime completes here, then the
// caller's user message is sent into an already-grounded session. Without this,
// a reasoning model freelances — it has no reliable signal pointing it at the
// right folder (a fresh instance has no state.json for file-based discovery to
// find), and clean user messages carry no path/skill context.

interface CachedSession {
  user_id: number;
  workflow_instance_id: string;
  session_id: string;
  opencode_port: number;
}

/** Grounding payload sent as the first (priming) message on session creation. */
export interface SessionPrime {
  /** Absolute instance folder, e.g. /workspace/carousels/<id>. */
  folder: string;
  /** OpenCode skill name, e.g. "canva-carousel". */
  skill: string;
  /** Workflow label, e.g. "Carousel Studio". */
  label: string;
  /** Optional extra instructions from the workflow's sessionPrompt. */
  instructions?: string;
}

/**
 * Returns a usable opencode session id for the given workflow instance, creating
 * + caching one if needed. Reuses the cached session only if it's on the same
 * port (i.e. the same container). When creating a NEW session, sends one
 * grounding prime message (synchronously) so the agent starts oriented to its
 * instance folder + skill before the user's first real message arrives.
 */
export async function getOrCreateSession(
  row: ContainerRow,
  workflowInstanceId: string,
  prime?: SessionPrime,
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

  // Prime only on fresh creation — never on cache hits or after a 404 retry
  // (the retry path already has a grounded session from the first attempt).
  if (prime) {
    const text = buildPrimeMessage(prime);
    console.log(`[opencode] priming session ${sessionId} for ${prime.folder}`);
    // Blocking send — completes before we return, so the user's first message
    // lands in a grounded session. The prime response is discarded; it just
    // needs to orient the agent, not produce anything user-facing.
    try {
      await sendMessage(row.opencode_port, sessionId, text);
    } catch (err) {
      // Non-fatal: if the prime fails, the user's message still goes through
      // (ungrounded). Log and continue rather than blocking the whole request.
      console.error(`[opencode] prime failed (non-fatal):`, err instanceof Error ? err.message : err);
    }
  }

  return sessionId;
}

/** Builds the one-time grounding message sent at session creation. */
function buildPrimeMessage(prime: SessionPrime): string {
  return [
    `You are now working in the ${prime.label} workflow.`,
    `Your active instance folder is ${prime.folder}. Read ${prime.folder}/AGENTS.md now — it names this instance concretely.`,
    `All files you read or write for this work go under ${prime.folder}. Do not write anywhere else.`,
    `Load the "${prime.skill}" skill and follow its procedure exactly and completely — do not stop partway to ask the user questions. You are running in autonomous mode (no interactive terminal), so operate end-to-end: parse input, run every phase, write every artifact, and report when done.`,
    `At each phase boundary, update ${prime.folder}/state.json (overwrite it) with {"phase": "<current>", "lastUpdated": "<ISO>", "errors": []} plus the workflow fields the canvas reads. When you finish or pause, append a handoff note to ${prime.folder}/memory.md.`,
    prime.instructions ? prime.instructions : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Clears the cached session for a workflow instance (e.g. if the server rejects it). */
export function invalidateSession(userId: number, workflowInstanceId: string): void {
  db()
    .prepare("DELETE FROM opencode_sessions WHERE user_id = ? AND workflow_instance_id = ?")
    .run(userId, workflowInstanceId);
}
