"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Agent chat state + send logic, keyed on a workflow instance. Extracted from
 * AgentPanel so any canvas can trigger a templated message (chat-trigger
 * buttons) without owning the transport.
 *
 * Transport: SSE. `send` POSTs to /api/tools/message, which streams back events:
 *   delta   → append to the streaming assistant reply bubble
 *   thinking→ replace the stationary reasoning panel (never pushes messages)
 *   tool    → status chip in the reasoning panel ("Generating image…")
 *   done    → finalize the assistant message from authoritative text; clear stream
 *   error   → surface + clear stream
 *
 * Per-lane state: each workflow instance gets its own message history and
 * streaming slot, keyed by instance id in maps. Switching lanes switches the
 * active view without losing the other lane's state.
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

/** Live streaming state for a lane — rendered in the stationary thinking panel. */
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
  /** Non-null while an assistant response is streaming in for the active lane. */
  streaming: StreamingState | null;
  /** Send a message to the active lane's session. No-op if no lane or busy. */
  send: (text: string) => Promise<void>;
  /** Clear visible history + error (called on lane switch). */
  reset: () => void;
}

type LaneMap<T> = Record<string, T>;

export function useAgentChat(workflowInstanceId: string | null): AgentChat {
  const [messagesByLane, setMessagesByLane] = useState<LaneMap<ChatMessage[]>>({});
  const [errorByLane, setErrorByLane] = useState<LaneMap<string | null>>({});
  const [streamingByLane, setStreamingByLane] = useState<LaneMap<StreamingState>>({});
  const [busy, setBusy] = useState(false);

  const laneKey = workflowInstanceId ?? "__none__";
  const messages = workflowInstanceId ? (messagesByLane[laneKey] ?? []) : [];
  const error = workflowInstanceId ? (errorByLane[laneKey] ?? null) : null;
  const streaming = workflowInstanceId ? (streamingByLane[laneKey] ?? null) : null;

  // Hold the latest instance id + busy flag in refs updated during the commit
  // phase (effects), so `send` — which is stable (empty deps) — can read the
  // current values without going stale and without re-creating on every render.
  const instanceRef = useRef(workflowInstanceId);
  const busyRef = useRef(false);
  useEffect(() => {
    instanceRef.current = workflowInstanceId;
  }, [workflowInstanceId]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  /** Parses the SSE response body and dispatches each frame to the lane state. */
  const consumeStream = useCallback(
    async (body: ReadableStream<Uint8Array>, key: string, assistantId: number) => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let reasoningAccum = "";

      const updateAssistant = (fn: (m: ChatMessage) => ChatMessage) => {
        setMessagesByLane((m) => ({
          ...m,
          [key]: (m[key] ?? []).map((msg) => (msg.id === assistantId ? fn(msg) : msg)),
        }));
      };
      const setStreaming = (s: StreamingState | null) => {
        setStreamingByLane((m) => {
          if (!s) {
            const n = { ...m };
            delete n[key];
            return n;
          }
          return { ...m, [key]: s };
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
            setErrorByLane((m) => ({ ...m, [key]: msg }));
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
    const instanceId = instanceRef.current;
    if (!trimmed || !instanceId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const key = instanceId;
    setErrorByLane((m) => ({ ...m, [key]: null }));

    const userMsg: ChatMessage = { id: Date.now(), role: "user", content: trimmed };
    const assistantId = Date.now() + 1;
    const assistantMsg: ChatMessage = { id: assistantId, role: "assistant", content: "", streaming: true };
    setMessagesByLane((m) => ({ ...m, [key]: [...(m[key] ?? []), userMsg, assistantMsg] }));
    setStreamingByLane((m) => ({ ...m, [key]: { assistantId, reasoningText: "" } }));

    try {
      const res = await fetch("/api/tools/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, workflowInstanceId: instanceId }),
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as ToolResponse;
        const msg = data.error ?? `Request failed (${res.status})`;
        throw new Error(data.detail ? `${msg} — ${data.detail}` : msg);
      }
      await consumeStream(res.body, key, assistantId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorByLane((m) => ({ ...m, [key]: msg }));
      // Mark the streaming assistant message as no longer streaming so it stops
      // showing the typing indicator.
      setMessagesByLane((m) => ({
        ...m,
        [key]: (m[key] ?? []).map((msg2) =>
          msg2.id === assistantId ? { ...msg2, streaming: false, content: msg2.content || "(no response)" } : msg2,
        ),
      }));
    } finally {
      setStreamingByLane((m) => {
        if (!m[key]) return m;
        const next = { ...m };
        delete next[key];
        return next;
      });
      busyRef.current = false;
      setBusy(false);
    }
  }, [consumeStream]);

  const reset = useCallback(() => {
    setMessagesByLane({});
    setErrorByLane({});
    setStreamingByLane({});
  }, []);

  return { messages, busy, error, streaming, send, reset };
}
