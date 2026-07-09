"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Agent chat state + send logic, keyed on an opaque "session key". Extracted
 * from AgentPanel so any canvas (or the Brand library) can trigger a templated
 * message without owning the transport.
 *
 * The session key is an opaque string that uniquely identifies a chat context:
 *   - a workflow lane  → "lane:<instanceId>" (or historically just the id)
 *   - a shared library → "brand"
 * Whatever the key is, its message history + streaming slot live in a per-key
 * map, so switching contexts switches the active view without losing state.
 *
 * `transport` tells `send` how to address the server. The server route accepts
 * either `workflowInstanceId` (lanes) or `library` (libraries); the hook stays
 * domain-agnostic by taking the payload key/value verbatim.
 *
 * Transport: SSE. `send` POSTs to /api/tools/message, which streams back events:
 *   delta   → append to the streaming assistant reply bubble
 *   thinking→ replace the stationary reasoning panel (never pushes messages)
 *   tool    → status chip in the reasoning panel ("Generating image…")
 *   done    → finalize the assistant message from authoritative text; clear stream
 *   error   → surface + clear stream
 */

export interface ToolResponse {
  ok?: boolean;
  text?: string;
  sessionId?: string;
  raw?: { parts?: Array<{ type?: string; text?: string }> };
  error?: string;
  detail?: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  response?: ToolResponse;
  /** Reasoning captured during streaming, surfaced under a collapsed "Show thinking". */
  reasoning?: string;
  /** True while this assistant message is still accumulating deltas. */
  streaming?: boolean;
}

/** Live streaming state for a session — rendered in the stationary thinking panel. */
export interface StreamingState {
  assistantId: number;
  /** Most recent reasoning text (replaces prior; full text, not deltas). */
  reasoningText: string;
  /** Latest tool status, if a tool is mid-flight. */
  toolStatus?: { title: string; status: "running" | "completed" | "error" };
}

export interface AgentChat {
  messages: ChatMessage[];
  busy: boolean;
  error: string | null;
  /** Non-null while an assistant response is streaming in for the active session. */
  streaming: StreamingState | null;
  /** Send a message to the active session. No-op if no session or busy. */
  send: (text: string) => Promise<void>;
  /** Clear ALL session history + error (nuclear; resets every chat context). */
  reset: () => void;
  /** Clear history + error for ONE session key only, leaving other contexts
   *  intact. Use when navigating within a context family (e.g. closing a brand
   *  card) so the next Ask AI starts fresh without wiping lane histories. */
  clearSession: (key: string) => void;
}

/**
 * Describes how a `send` is addressed on the wire. The payload is merged into
 * the POST body alongside `{ message }`. Callers pass exactly one targeting
 * field, e.g. `{ key: "workflowInstanceId", value: instanceId }` or
 * `{ key: "library", value: "brand" }`.
 *
 * `card` is optional context for library sessions (e.g. which Brand Kit card is
 * open) so the server can scope the agent per-card. Ignored by lane transports.
 */
export interface ChatTransport {
  key: string;
  value: string;
  card?: string;
}

type SessionMap<T> = Record<string, T>;

export function useAgentChat(sessionKey: string | null, transport: ChatTransport | null): AgentChat {
  const [messagesBySession, setMessagesBySession] = useState<SessionMap<ChatMessage[]>>({});
  const [errorBySession, setErrorBySession] = useState<SessionMap<string | null>>({});
  const [streamingBySession, setStreamingBySession] = useState<SessionMap<StreamingState>>({});
  const [busy, setBusy] = useState(false);

  const key = sessionKey ?? "__none__";
  const messages = sessionKey ? (messagesBySession[key] ?? []) : [];
  const error = sessionKey ? (errorBySession[key] ?? null) : null;
  const streaming = sessionKey ? (streamingBySession[key] ?? null) : null;

  // Hold the latest session key + transport + busy flag in refs updated during
  // the commit phase (effects), so `send` — which is stable (empty deps) — can
  // read the current values without going stale and without re-creating.
  const sessionRef = useRef(sessionKey);
  const transportRef = useRef(transport);
  const busyRef = useRef(false);
  useEffect(() => {
    sessionRef.current = sessionKey;
  }, [sessionKey]);
  useEffect(() => {
    transportRef.current = transport;
  }, [transport]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  /** Parses the SSE response body and dispatches each frame to the session state. */
  const consumeStream = useCallback(
    async (body: ReadableStream<Uint8Array>, sKey: string, assistantId: number) => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let reasoningAccum = "";

      const updateAssistant = (fn: (m: ChatMessage) => ChatMessage) => {
        setMessagesBySession((m) => ({
          ...m,
          [sKey]: (m[sKey] ?? []).map((msg) => (msg.id === assistantId ? fn(msg) : msg)),
        }));
      };
      const setStreaming = (s: StreamingState | null) => {
        setStreamingBySession((m) => {
          if (!s) {
            const n = { ...m };
            delete n[sKey];
            return n;
          }
          return { ...m, [sKey]: s };
        });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const jsonStr = line.slice("data:".length).trim();
          if (!jsonStr) continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(jsonStr) as Record<string, unknown>;
          } catch {
            continue;
          }
          const type = evt.type as string;
          if (type === "delta") {
            const t = (evt.text as string) ?? "";
            if (t) updateAssistant((m) => ({ ...m, content: m.content + t }));
          } else if (type === "thinking") {
            // Reasoning is sent as full text (replaces prior) — keep a single
            // stationary panel rather than scrolling.
            const t = (evt.text as string) ?? "";
            reasoningAccum = t;
            updateAssistant((m) => ({ ...m, reasoning: t }));
            setStreaming({ assistantId, reasoningText: t });
          } else if (type === "tool") {
            const title = (evt.title as string) ?? "tool";
            const status = (evt.status as "running" | "completed" | "error") ?? "running";
            setStreaming({ assistantId, reasoningText: reasoningAccum, toolStatus: { title, status } });
          } else if (type === "done") {
            const final = (evt.text as string) ?? "";
            updateAssistant((m) => ({
              ...m,
              // Authoritative final text wins if the deltas were missed/empty.
              content: final || m.content || "(no response)",
              streaming: false,
            }));
            setStreaming(null);
          } else if (type === "error") {
            const msg = (evt.message as string) ?? "stream error";
            setErrorBySession((m) => ({ ...m, [sKey]: msg }));
            updateAssistant((m) => ({ ...m, streaming: false, content: m.content || "(error)" }));
            setStreaming(null);
          }
        }
      }
    },
    [],
  );

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    const sKey = sessionRef.current;
    const tport = transportRef.current;
    if (!trimmed || !sKey || !tport || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErrorBySession((m) => ({ ...m, [sKey]: null }));

    const userMsg: ChatMessage = { id: Date.now(), role: "user", content: trimmed };
    const assistantId = Date.now() + 1;
    const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", content: "", streaming: true };
    setMessagesBySession((m) => ({ ...m, [sKey]: [...(m[sKey] ?? []), userMsg, assistantMsg] }));
    setStreamingBySession((m) => ({ ...m, [sKey]: { assistantId, reasoningText: "" } }));

    try {
      const payload: Record<string, string> = { message: trimmed, [tport.key]: tport.value };
      if (tport.card) payload.card = tport.card;
      const res = await fetch("/api/tools/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as ToolResponse;
        const msg = data.error ?? `Request failed (${res.status})`;
        throw new Error(data.detail ? `${msg} — ${data.detail}` : msg);
      }
      await consumeStream(res.body, sKey, assistantId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorBySession((m) => ({ ...m, [sKey]: msg }));
      setMessagesBySession((m) => ({
        ...m,
        [sKey]: (m[sKey] ?? []).map((msg2) =>
          msg2.id === assistantId ? { ...msg2, streaming: false, content: msg2.content || "(no response)" } : msg2,
        ),
      }));
    } finally {
      setStreamingBySession((m) => {
        if (!m[sKey]) return m;
        const next = { ...m };
        delete next[sKey];
        return next;
      });
      busyRef.current = false;
      setBusy(false);
    }
  }, [consumeStream]);

  const reset = useCallback(() => {
    setMessagesBySession({});
    setErrorBySession({});
    setStreamingBySession({});
  }, []);

  const clearSession = useCallback((sKey: string) => {
    setMessagesBySession((m) => {
      if (!m[sKey]) return m;
      const next = { ...m };
      delete next[sKey];
      return next;
    });
    setErrorBySession((m) => {
      if (!m[sKey]) return m;
      const next = { ...m };
      delete next[sKey];
      return next;
    });
    setStreamingBySession((m) => {
      if (!m[sKey]) return m;
      const next = { ...m };
      delete next[sKey];
      return next;
    });
  }, []);

  return { messages, busy, error, streaming, send, reset, clearSession };
}
