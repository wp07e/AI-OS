"use client";

import { useEffect, useRef, useState } from "react";

interface ToolResponse {
  ok?: boolean;
  text?: string;
  sessionId?: string;
  raw?: { parts?: Array<{ type?: string; text?: string }> };
  error?: string;
  detail?: string;
}

interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  response?: ToolResponse;
}

interface Props {
  /** Active workflow instance id, or null in M0 (legacy user-keyed session). */
  workflowInstanceId: string | null;
  /** Active workflow type (for the panel header), or null. */
  workflowType: string | null;
}

/**
 * Persistent chat panel on the right of the shell. Sends messages to
 * /api/tools/message. When workflowInstanceId is provided (M1+), each lane gets
 * its own opencode session; when null (M0 fallback), the legacy user-keyed
 * session is used.
 *
 * Message history is held in local state. Switching workflow instances resets
 * the visible history (each lane's session lives server-side in opencode; a
 * future enhancement can hydrate history on lane switch).
 */
export function AgentPanel({ workflowInstanceId, workflowType }: Props) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset visible history when the lane changes — each lane is its own session.
  useEffect(() => {
    setMessages([]);
    setError(null);
  }, [workflowInstanceId]);

  // Keep the latest message in view as it arrives.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy || !workflowInstanceId) return;

    setError(null);
    setBusy(true);
    setInput("");

    const userMsg: Message = { id: Date.now(), role: "user", content: text };
    setMessages((m) => [...m, userMsg]);

    try {
      const res = await fetch("/api/tools/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          // Omit when null so M0 keeps the legacy path; M1 keys on this.
          ...(workflowInstanceId ? { workflowInstanceId } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as ToolResponse;
      if (!res.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        if (data.detail) setError(`${data.error ?? "Request failed"} — ${data.detail}`);
        return;
      }
      const assistantText = data.text?.trim() || "(assistant returned no text)";
      setMessages((m) => [
        ...m,
        { id: Date.now() + 1, role: "assistant", content: assistantText, response: data },
      ]);
    } catch {
      setError("Network error sending message.");
    } finally {
      setBusy(false);
    }
  }

  const headerLabel = workflowType ? `${workflowType} lane` : "Agent";

  return (
    <aside className="flex min-h-0 flex-col bg-[var(--card)]/20">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-white/10 px-3">
        <div className="flex items-center gap-2">
          <span className="grid h-5 w-5 place-items-center rounded-md bg-gradient-to-br from-indigo-500 to-sky-400 text-[10px] font-bold text-white">
            AI
          </span>
          <span className="text-xs font-medium tracking-tight">{headerLabel}</span>
        </div>
        <label className="flex cursor-pointer items-center gap-1 text-[10px] text-[var(--muted)]">
          <input
            type="checkbox"
            checked={showDebug}
            onChange={(e) => setShowDebug(e.target.checked)}
            className="h-2.5 w-2.5 accent-indigo-400"
          />
          raw
        </label>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        {!workflowInstanceId ? (
          <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-[var(--muted)]">
            No workflow selected.
            <br />
            Create or pick one on the left to start.
          </div>
        ) : messages.length === 0 && !error ? (
          <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-[var(--muted)]">
            Talk to the agent to drive this workflow.
          </div>
        ) : null}

        <div className="flex flex-col gap-2.5">
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} showDebug={showDebug} />
          ))}
          {busy && (
            <div className="self-start rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-[var(--muted)]">
              <span className="inline-flex gap-1">
                <Dot delay="0ms" />
                <Dot delay="150ms" />
                <Dot delay="300ms" />
              </span>
            </div>
          )}
        </div>

        {error && (
          <p className="mt-2 rounded-md bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">{error}</p>
        )}
      </div>

      <form
        onSubmit={send}
        className="flex shrink-0 gap-2 border-t border-white/10 bg-gradient-to-t from-[var(--background)] to-transparent p-3"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={workflowInstanceId ? "Message the agent…" : "Select a workflow to chat…"}
          className="flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/30 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || !workflowInstanceId}
        />
        <button
          type="submit"
          disabled={busy || !input.trim() || !workflowInstanceId}
          className="rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "…" : "↵"}
        </button>
      </form>
    </aside>
  );
}

function MessageBubble({ message, showDebug }: { message: Message; showDebug: boolean }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={
          isUser
            ? "max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-indigo-500/90 px-3 py-2 text-sm text-white shadow-md shadow-indigo-500/20"
            : "max-w-[90%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.03] px-3 py-2 text-sm"
        }
      >
        {message.content}
      </div>
      {!isUser && message.response?.raw?.parts && showDebug && (
        <details className="w-full rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[10px]">
          <summary className="cursor-pointer text-[var(--muted)]">
            raw parts ({message.response.raw.parts.length})
          </summary>
          <pre className="mt-1.5 overflow-auto whitespace-pre-wrap break-words font-mono text-[9px] leading-relaxed text-[var(--muted)]">
            {JSON.stringify(message.response.raw.parts, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--muted)]"
      style={{ animationDelay: delay, animationDuration: "0.9s" }}
    />
  );
}
