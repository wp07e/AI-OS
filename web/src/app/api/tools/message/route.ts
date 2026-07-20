import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getContainerForUser } from "@/lib/docker";
import { db } from "@/lib/db";
import {
  extractAssistantText,
  getOrCreateSession,
  getOrCreateLibrarySession,
  invalidateSession,
  invalidateLibrarySession,
  isStaleSessionError,
  listMessages,
  promptAsync,
  subscribeEvents,
  type OpencodeEvent,
  type SessionPrime,
} from "@/lib/opencode";
import { getWorkflow } from "@/lib/workflows/registry";
import { brandSessionPrime } from "@/lib/brand/prime";
import { brandCardPreamble } from "@/lib/brand/preamble";
import { isBrandCardKey } from "@/lib/brand/cards";
import { buildAutomationPrefill } from "@/lib/video/automation-prefill";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * Streaming message route. Replaces the old blocking POST that held a single
 * fetch open until the agent finished (and timed out at ~5min on long carousel
 * pipelines).
 *
 * Now: this route is a per-request SSE bridge between the browser and OpenCode's
 * own /event stream. It fires a `prompt_async` (returns 204 immediately), then
 * relays filtered events to the browser until the session goes idle. Continuous
 * frames keep the connection alive → no idle timeout. Mirrors the SSE shape used
 * by /api/oauth/start/route.ts.
 *
 * Browser-facing event vocabulary (simpler than OpenCode's raw types):
 *   data: {"type":"thinking","text":"..."}     ← reasoning (stationary)
 *   data: {"type":"delta","text":"..."}        ← assistant reply token (append)
 *   data: {"type":"tool","title":"...","status":"running|completed|error"}
 *   data: {"type":"done","text":"<authoritative final text>"}
 *   data: {"type":"error","message":"..."}
 *
 * Every stage is timed and logged to the server console under `[msg]`.
 */
function log(stage: string, fields?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const body = fields ? " " + JSON.stringify(fields) : "";
  console.log(`[msg] ${ts} ${stage}${body}`);
}

export async function POST(req: Request) {
  const t0 = Date.now();
  log("POST /api/tools/message — start (streaming)");

  const user = await currentUser();
  if (!user) {
    log("reject — no user");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    log("reject — container not ready", { status: row?.status ?? null });
    return NextResponse.json({ error: "container not ready" }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  // Two targeting modes: a workflow lane (workflowInstanceId) or a shared
  // library (library). Each resolves to an opencode session + a one-time prime.
  // The brand path has no workflow_instances row, so it uses the library
  // session cache instead.
  const library = String(body.library ?? "").trim();
  const workflowInstanceId = String(body.workflowInstanceId ?? "").trim();

  /** Resolves the opencode session id (creating + priming on first use). */
  let resolveSession: () => Promise<string>;
  /** Invalidate + retry on a stale (404) session. */
  let invalidate: () => void;
  /** The text actually delivered to the agent. Defaults to the raw user message;
   *  library sessions prepend a per-card scoping preamble (hidden from the UI). */
  let deliveredMessage = message;

  if (library) {
    // ── Library path (brand, …) ────────────────────────────────────────────
    const prime = libraryPrime(library);
    if (!prime) {
      return NextResponse.json({ error: `unknown library '${library}'` }, { status: 400 });
    }
    resolveSession = () => getOrCreateLibrarySession(row, library, prime);
    invalidate = () => invalidateLibrarySession(user.id, library);
    // Prepend the card-specific preamble so the agent knows its exact scope +
    // refusal rules each turn. The route filters user-message echoes from the
    // event stream, so this stays hidden from the chat bubbles.
    const card = String(body.card ?? "").trim();
    const preamble = libraryPreamble(library, card);
    if (preamble) deliveredMessage = `${preamble}\n${message}`;
    log("target — library", { library, folder: prime.folder, card: card || null });
  } else {
    // ── Workflow lane path (unchanged) ─────────────────────────────────────
    if (!workflowInstanceId) {
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

    // Silent brand-context prefill: if the lane has an active brand selection,
    // prepend a concise summary (colors, typography, voice, selected assets) so
    // the agent reasons WITH the brand when writing the brief + slide copy.
    // Empty when no selection is applied → no noise. Hidden from the chat
    // bubbles (the route filters user-message echoes from the event stream).
    //
    // Automation prefill: if the lane has an automation_request.json (written
    // by the automate route), prepend an automation-mode context block so the
    // agent knows to analyze assets + write a storyboard + run the script.
    const { buildLaneBrandPrefill } = await import("@/lib/brand/lane-prefill");
    const brandPrefill = await buildLaneBrandPrefill(row, instance.folder);
    const automationPrefill = await buildAutomationPrefill(row, instance.folder);
    // Blender lease prefill: tells the agent the current GPU lease state so it
    // knows whether blender tools are reachable. Empty for non-Blender lanes.
    const { buildBlenderLeasePrefill, isBlenderInstance } = await import("@/lib/gpu/blender-prefill");
    const blenderPrefill = isBlenderInstance(workflowInstanceId)
      ? await buildBlenderLeasePrefill(row, workflowInstanceId, instance.folder)
      : "";
    const prefills = [automationPrefill, blenderPrefill, brandPrefill].filter(Boolean).join("\n\n");
    if (prefills) deliveredMessage = `${prefills}\n\n${message}`;

    // Build the one-time session prime. Sent ONLY when a new session is created
    // (inside getOrCreateSession); no-op on a cache hit.
    const def = getWorkflow(instance.workflow_type);
    const prime: SessionPrime = {
      folder: instance.folder,
      skill: def?.skill ?? instance.workflow_type,
      sessionPrompt: def?.sessionPrompt,
    };
    resolveSession = () => getOrCreateSession(row, workflowInstanceId, prime);
    invalidate = () => invalidateSession(user.id, workflowInstanceId);
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* controller closed — drop */
        }
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      try {
        let sessionId: string;
        try {
          // resolveSession primes only on the first (new-session) call. The
          // retry below re-resolves without a prime: a 404-retry means the
          // session was already primed on the first attempt; re-priming would
          // duplicate the grounding.
          sessionId = await resolveSession();
          log("session resolved", { sessionId });
          await drivePrompt(row, sessionId, deliveredMessage, send, abort.signal, /*attempt*/ 1);
        } catch (err) {
          if (isStaleSessionError(err)) {
            log("session rejected (404) — invalidating + retrying");
            invalidate();
            // No prime on retry — see note above. Re-resolve via the library
            // path if that's the active mode, else the workflow path.
            if (library) {
              sessionId = await getOrCreateLibrarySession(row, library);
            } else {
              sessionId = await getOrCreateSession(row, workflowInstanceId);
            }
            log("session resolved (retry)", { sessionId });
            log("getOrCreateSession (retry) — done", { sessionId });
            await drivePrompt(row, sessionId, deliveredMessage, send, abort.signal, /*attempt*/ 2);
          } else {
            throw err;
          }
        }
        log("POST — ok (streaming complete)", { totalMs: Date.now() - t0 });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log("POST — FAIL (streaming)", { totalMs: Date.now() - t0, detail });
        send({ type: "error", message: detail });
      } finally {
        abort.abort();
        close();
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Fires `prompt_async`, subscribes to /event, and relays filtered events to the
 * browser until `session.idle` (or `session.error`). On idle, fetches the
 * authoritative final assistant text via `listMessages` and emits `done`.
 *
 * Filters the global event stream by the target session id — OpenCode has no
 * per-session SSE filter, so every workspace event arrives here and we discard
 * the ones that don't match.
 */
async function drivePrompt(
  row: { opencode_port: number },
  sessionId: string,
  message: string,
  send: (obj: Record<string, unknown>) => void,
  signal: AbortSignal,
  attempt: number,
): Promise<void> {
  let idle = false;
  // Track which messageIDs are user-role so we don't relay the user's own input
  // back as an assistant delta (OpenCode echoes the user part as a text event).
  // Assistant messageIDs are anything not classified as user.
  const userMessageIds = new Set<string>();

  const stop = subscribeEvents(row.opencode_port, (evt) => {
    if (idle) return;
    try {
      handleEvent(evt, sessionId, send, userMessageIds, () => {
        idle = true;
      });
    } catch {
      /* a single bad frame shouldn't kill the stream */
    }
  }, signal);

  try {
    log("prompt_async — start", { attempt });
    await promptAsync(row.opencode_port, sessionId, message);
    log("prompt_async — accepted (204)", { attempt });
  } finally {
    // Don't stop the subscription here — it must keep relaying until idle/error.
    // The caller's finally block aborts the signal (which stops it) on exit.
  }

  // Wait until the event handler flips `idle` (session.idle) or the signal aborts.
  // While waiting, send periodic heartbeat events down the SSE stream. This keeps
  // data flowing so the connection isn't dropped by an idle-timeout at any proxy
  // layer, and keeps the client's typing indicator alive during long generations
  // (the deterministic carousel script can run 3-4 minutes with no OpenCode events).
  const deadline = Date.now() + 600_000;
  let lastBeat = Date.now();
  while (!idle && !signal.aborted && Date.now() < deadline) {
    await sleep(200);
    if (!idle && Date.now() - lastBeat >= 5_000) {
      lastBeat = Date.now();
      // Emit as a tool frame so the client's typing indicator + thinking panel
      // stay alive without scrolling the chat or producing visible "tool" text.
      // status "running" keeps the existing "working…" affordance going.
      send({ type: "tool", title: "Working", status: "running" });
    }
  }

  // After idle: fetch authoritative final text and emit done. Guards against
  // missed early SSE events (e.g. if the subscription connected a tick late).
  if (idle) {
    try {
      const msgs = await listMessages(row.opencode_port, sessionId);
      const final = pickLastAssistant(msgs);
      send({ type: "done", text: final });
    } catch (err) {
      // listMessages failed — still emit done with empty text so the client
      // finalizes rather than hanging; surface the failure as an error too.
      const detail = err instanceof Error ? err.message : String(err);
      log("listMessages — failed after idle", { detail });
      send({ type: "done", text: "" });
    }
  }

  stop();
}

/** Translates one OpenCode event into the browser-facing vocabulary, gated on sessionID. */
function handleEvent(
  evt: OpencodeEvent,
  sessionId: string,
  send: (obj: Record<string, unknown>) => void,
  userMessageIds: Set<string>,
  onIdle: () => void,
): void {
  const props = evt.properties ?? {};

  switch (evt.type) {
    case "session.idle": {
      if (props.sessionID === sessionId) onIdle();
      return;
    }
    case "session.error": {
      if (props.sessionID != null && props.sessionID !== sessionId) return;
      const err = props.error as { message?: string } | undefined;
      send({ type: "error", message: err?.message ?? "session error" });
      onIdle();
      return;
    }
    case "message.updated": {
      // Classify messageIDs by role so we can skip the user's own echoed text.
      const info = props.info as { id?: string; role?: string } | undefined;
      if (info?.id && info.role === "user") userMessageIds.add(info.id);
      return;
    }
    case "message.part.updated": {
      const part = props.part as
        | { sessionID?: string; messageID?: string; type?: string; text?: string; delta?: string }
        | undefined;
      if (!part || part.sessionID !== sessionId) return;
      // Skip the user's own input — OpenCode emits it as a text part too, and
      // relaying it would echo the question into the assistant bubble until the
      // real reply (and the final done-overwrite) arrives.
      if (part.type === "text" && part.messageID && userMessageIds.has(part.messageID)) {
        return;
      }
      if (part.type === "reasoning") {
        send({ type: "thinking", text: part.text ?? "" });
      } else if (part.type === "text") {
        // Prefer delta (incremental) when present; fall back to full text.
        send({ type: "delta", text: part.delta ?? part.text ?? "" });
      } else if (part.type === "tool") {
        relayTool(props.part as Record<string, unknown>, send);
      }
      return;
    }
    default:
      return;
  }
}

/** Emits a tool status frame: title + running/completed/error. */
function relayTool(part: Record<string, unknown>, send: (obj: Record<string, unknown>) => void): void {
  const state = part.state as { status?: string; title?: string; error?: string } | undefined;
  if (!state) return;
  const status = state.status === "completed" ? "completed" : state.status === "error" ? "error" : "running";
  send({
    type: "tool",
    title: state.title ?? (part.tool as string | undefined) ?? "tool",
    status,
    ...(status === "error" && state.error ? { error: state.error } : {}),
  });
}

/** Picks the concatenated text from the last assistant message in a session. */
function pickLastAssistant(
  msgs: { info: { role?: string }; parts: Array<Record<string, unknown>> }[],
): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.info.role === "assistant") {
      const text = m.parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  // Fall back to extracting from whatever the response parts give us.
  return extractAssistantText({ info: {}, parts: msgs.flatMap((m) => m.parts) });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Returns the session prime for a shared library key, or null if the key isn't
 * a known library. Currently only "brand" is supported.
 */
function libraryPrime(library: string): SessionPrime | null {
  if (library === "brand") return brandSessionPrime();
  return null;
}

/**
 * Returns the per-card scoping preamble for a library session, or null if the
 * library/card combo doesn't have one (e.g. unknown card). Used to prepend
 * hidden context to each brand message so the agent knows its exact scope.
 */
function libraryPreamble(library: string, card: string): string | null {
  if (library === "brand" && isBrandCardKey(card)) return brandCardPreamble(card);
  return null;
}
