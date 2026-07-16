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

/**
 * True when the opencode server reports the Canva MCP as connected.
 *
 * The `/mcp` endpoint returns an object keyed by MCP server name, each with a
 * `status` field ("connected" | "needs_auth" | ...). This is the single source
 * of truth for "can the agent reach Canva right now?" — there is no DB flag;
 * status is always derived live from the container. Used to gate Canva-dependent
 * workflows (e.g. Carousel Studio) and by the post-OAuth restart poll.
 */
export async function isCanvaConnected(port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(opencodeUrl(port, "/mcp"), {
      signal: ctrl.signal,
      headers: headers(),
    });
    clearTimeout(t);
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as
      | Record<string, { status?: string }>
      | null;
    return data?.Canva?.status === "connected";
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
// here so multi-turn conversations persist across requests.
//
// INVALIDATION: a cached session is reused only if BOTH the port AND the
// container_id match. The port alone is insufficient — `docker compose up
// --force-recreate` and `restart` reuse the same published ports but spawn a
// fresh opencode process with an EMPTY session list. Comparing container_id
// (which changes on every recreate) catches this and forces a new session,
// avoiding 404 "Session not found" errors from a stale cache.

interface CachedSession {
  user_id: number;
  workflow_instance_id: string;
  session_id: string;
  opencode_port: number;
  container_id: string | null;
}

/** Grounding payload sent as the first (priming) message on session creation. */
export interface SessionPrime {
  /** Absolute instance folder, e.g. /workspace/carousels/<id>. */
  folder: string;
  /** OpenCode skill name, e.g. "canva-carousel". */
  skill: string;
  /** Optional workflow-specific session prompt from the registry's
   *  WorkflowDefinition.sessionPrompt. Appended to the prime message so the
   *  agent reads memory.md + state.json for session resume. */
  sessionPrompt?: string;
}

/** Reads a cached session row, but only if the container is unchanged (same
 *  port AND container_id). Returns null otherwise (no creation, no priming).
 *  Shared by getOrCreate* (reuse-on-hit) and the abort route (resolve-only). */
function lookupCachedSession(
  row: { opencode_port: number; container_id: string | null },
  table: "opencode_sessions" | "library_sessions",
  where: [string, ...unknown[]],
): string | null {
  const cached = db()
    .prepare(`SELECT * FROM ${table} WHERE ${where[0]}`)
    .get(...where.slice(1)) as CachedSession | undefined;
  if (!cached) return null;
  if (cached.opencode_port !== row.opencode_port || cached.container_id !== row.container_id) return null;
  return cached.session_id;
}

/** Read-only cached session id for a workflow lane, or null if absent/stale. */
export function getCachedWorkflowSession(
  userId: number,
  workflowInstanceId: string,
  row: { opencode_port: number; container_id: string | null },
): string | null {
  return lookupCachedSession(row, "opencode_sessions", [
    "user_id = ? AND workflow_instance_id = ?",
    userId,
    workflowInstanceId,
  ]);
}

/** Read-only cached session id for a library, or null if absent/stale. */
export function getCachedLibrarySession(
  userId: number,
  libraryKey: string,
  row: { opencode_port: number; container_id: string | null },
): string | null {
  return lookupCachedSession(row, "library_sessions", [
    "user_id = ? AND library_key = ?",
    userId,
    libraryKey,
  ]);
}

/**
 * Best-effort abort of the active turn in a session. Fires OpenCode's
 * `POST /session/:id/abort`, which cancels the running agent fiber and
 * propagates an abort signal to the LLM stream + any in-flight tool calls.
 *
 * Tolerates any failure: a non-2xx may mean the turn is already idle, the
 * session is stale, or this OpenCode version predates the abort endpoint. In all
 * those cases the client has already unlocked its UI — we just log and move on.
 * Never throws.
 */
export async function abortSession(port: number, sessionId: string): Promise<void> {
  try {
    const res = await fetch(opencodeUrl(port, `/session/${sessionId}/abort`), {
      method: "POST",
      headers: headers(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log(
        `[opencode] POST /session/${sessionId}/abort → ${res.status} ${body.slice(0, 200) || "<no body>"} (non-fatal)`,
      );
    }
  } catch (err) {
    console.log(`[opencode] abort failed (non-fatal):`, err instanceof Error ? err.message : err);
  }
}

/**
 * Returns a usable opencode session id for the given workflow instance, creating
 * + caching one if needed. Reuses the cached session only if the container
 * hasn't changed (same port AND same container_id).
 *
 * PRIME: when a session is created (cache miss), one grounding message is sent
 * synchronously before this function returns. It tells the agent its concrete
 * instance folder and — critically — instructs it to READ THE SKILL FILE before
 * doing anything. Without this, a reasoning model sees "carousel" + available
 * Canva tools and shortcuts straight to calling them, ignoring the deterministic
 * procedure. The prime is a separate opencode message whose response is
 * discarded; the user's real message then lands in an already-grounded session.
 *
 * Earlier the prime appeared to "leak into chat" / cause "session error" — that
 * was actually the missing-OPENAI_API-key bug (401 on every call), not the prime.
 * With auth restored the prime runs cleanly and its output never reaches the
 * browser (only the user's subsequent streamed message does).
 */
export async function getOrCreateSession(
  row: ContainerRow,
  workflowInstanceId: string,
  prime?: SessionPrime,
): Promise<string> {
  const cached = getCachedWorkflowSession(row.user_id, workflowInstanceId, row);

  // Reuse only if the container is unchanged. A recreated container has the
  // same port but a different container_id and a fresh (empty) session list.
  if (cached) {
    return cached;
  }

  const sessionId = await createSession(row.opencode_port);
  db()
    .prepare(
      `INSERT INTO opencode_sessions (user_id, workflow_instance_id, session_id, opencode_port, container_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, workflow_instance_id) DO UPDATE SET
         session_id = excluded.session_id,
         opencode_port = excluded.opencode_port,
         container_id = excluded.container_id,
         created_at = excluded.created_at`,
    )
    .run(row.user_id, workflowInstanceId, sessionId, row.opencode_port, row.container_id, Date.now());

  // Prime only on fresh session creation — never on cache hits or 404 retries.
  // This grounds the agent: tells it its folder AND to read the skill file
  // before doing anything. The response is discarded; it just orients the
  // agent so the user's first real message lands in a grounded session.
  if (prime) {
    const text = buildPrimeMessage(prime);
    console.log(`[opencode] priming session ${sessionId} for ${prime.folder} (skill: ${prime.skill})`);
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

/**
 * Builds the one-time grounding message. The key instruction: READ THE SKILL
 * FILE before acting. Without this, the agent sees "carousel" + Canva tools and
 * shortcuts to calling them directly, ignoring the deterministic procedure.
 */
function buildPrimeMessage(prime: SessionPrime): string {
  const lines = [
    `You are now working in the ${prime.skill} context.`,
    ``,
    `Your working folder is ${prime.folder}.`,
    ``,
    `BEFORE doing anything else, read the skill file:`,
    `  /workspace/skills/${prime.skill}/SKILL.md  — the procedure you MUST follow.`,
    `Also read ${prime.folder}/AGENTS.md if it exists.`,
    ``,
    `Follow the SKILL.md procedure exactly. You are in autonomous mode (no`,
    `interactive terminal), so operate end-to-end without stopping to ask the`,
    `user questions.`,
  ];
  if (prime.sessionPrompt) {
    lines.push(``, prime.sessionPrompt);
  }
  lines.push(``, `Acknowledge briefly, then wait for the user's request.`);
  return lines.join("\n");
}

/** Clears the cached session for a workflow instance (e.g. if the server rejects it). */
export function invalidateSession(userId: number, workflowInstanceId: string): void {
  db()
    .prepare("DELETE FROM opencode_sessions WHERE user_id = ? AND workflow_instance_id = ?")
    .run(userId, workflowInstanceId);
}

// ─── Per-(user, library) session caching ────────────────────────────────────
//
// Shared libraries (brand, templates, ...) also need a persistent opencode
// session, but they aren't workflow_instances — so they can't share the
// opencode_sessions table (its workflow_instance_id has a FK to
// workflow_instances). library_sessions mirrors that table keyed on
// (user_id, library_key) instead, with the same container-id invalidation rule.

/**
 * Returns a usable opencode session id for the given library, creating +
 * caching one if needed. Reuses the cached session only if the container
 * hasn't changed (same port AND container_id). Prime is sent once on creation.
 */
export async function getOrCreateLibrarySession(
  row: ContainerRow,
  libraryKey: string,
  prime?: SessionPrime,
): Promise<string> {
  const cached = getCachedLibrarySession(row.user_id, libraryKey, row);

  if (cached) {
    return cached;
  }

  const sessionId = await createSession(row.opencode_port);
  db()
    .prepare(
      `INSERT INTO library_sessions (user_id, library_key, session_id, opencode_port, container_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, library_key) DO UPDATE SET
         session_id = excluded.session_id,
         opencode_port = excluded.opencode_port,
         container_id = excluded.container_id,
         created_at = excluded.created_at`,
    )
    .run(row.user_id, libraryKey, sessionId, row.opencode_port, row.container_id, Date.now());

  if (prime) {
    const text = buildPrimeMessage(prime);
    console.log(`[opencode] priming library session ${sessionId} for ${libraryKey} (folder: ${prime.folder})`);
    try {
      await sendMessage(row.opencode_port, sessionId, text);
    } catch (err) {
      console.error(`[opencode] library prime failed (non-fatal):`, err instanceof Error ? err.message : err);
    }
  }

  return sessionId;
}

/** Clears the cached session for a library (e.g. if the server rejects it). */
export function invalidateLibrarySession(userId: number, libraryKey: string): void {
  db()
    .prepare("DELETE FROM library_sessions WHERE user_id = ? AND library_key = ?")
    .run(userId, libraryKey);
}
