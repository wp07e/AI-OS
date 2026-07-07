"use client";

import { useEffect, useRef, useState } from "react";
import { useAgentChatContext } from "@/lib/hooks/AgentChatContext";
import type { ChatMessage, StreamingState } from "@/lib/hooks/useAgentChat";

interface Props {
  /** Active workflow instance id, or null when nothing is selected. */
  workflowInstanceId: string | null;
  /** Active workflow type (for the panel header), or null. */
  workflowType: string | null;
}

/**
 * Persistent chat panel on the right of the shell. Presentational consumer of
 * the agent chat owned by AppShell (via AgentChatContext). The chat hook does
 * the transport; this component renders messages + the input and calls
 * `send()`. Toolbar buttons in canvases reach the same `send()` through context.
 *
 * Message history is held in the chat hook's state and resets when the lane
 * changes (each lane's session lives server-side in opencode).
 */
export function AgentPanel({ workflowInstanceId, workflowType }: Props) {
  const chat = useAgentChatContext();
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the latest message in view as it arrives.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.messages, chat.busy]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || chat.busy || !workflowInstanceId) return;
    setInput("");
    await chat.send(text);
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
        ) : chat.messages.length === 0 && !chat.error ? (
          <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-[var(--muted)]">
            Talk to the agent to drive this workflow.
          </div>
        ) : null}

        <div className="flex flex-col gap-2.5">
          {chat.messages.map((m) => (
            <MessageBubble key={m.id} message={m} showDebug={showDebug} />
          ))}
          {chat.busy && (
            <div className="self-start rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-[var(--muted)]">
              <span className="inline-flex gap-1">
                <Dot delay="0ms" />
                <Dot delay="150ms" />
                <Dot delay="300ms" />
              </span>
            </div>
          )}
        </div>

        {chat.error && (
          <p className="mt-2 rounded-md bg-red-500/10 px-2 py-1.5 text-[11px] text-red-300">{chat.error}</p>
        )}
      </div>

      {/* Stationary thinking band — sits OUTSIDE the scroll area so reasoning
          updates never push existing messages down. Vanishes when streaming ends. */}
      {chat.streaming && <ThinkingBand streaming={chat.streaming} />}

      <form
        onSubmit={onSubmit}
        className="flex shrink-0 gap-2 border-t border-white/10 bg-gradient-to-t from-[var(--background)] to-transparent p-3"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={workflowInstanceId ? "Message the agent…" : "Select a workflow to chat…"}
          className="flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/30 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={chat.busy || !workflowInstanceId}
        />
        <button
          type="submit"
          disabled={chat.busy || !input.trim() || !workflowInstanceId}
          className="rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {chat.busy ? "…" : "↵"}
        </button>
      </form>
    </aside>
  );
}

function MessageBubble({ message, showDebug }: { message: ChatMessage; showDebug: boolean }) {
  const isUser = message.role === "user";
  const streaming = "streaming" in message && message.streaming;
  // Assistant may still be accumulating deltas — show a caret while it streams.
  const showCaret = !isUser && streaming;
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
        {showCaret && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-indigo-400 align-middle" />}
      </div>
      {!isUser && message.reasoning && (
        <details className="w-full rounded-lg border border-white/5 bg-black/20 px-2 py-1 text-[10px]">
          <summary className="cursor-pointer text-[var(--muted)]">Show thinking</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[9px] leading-relaxed text-[var(--muted)]">
            {message.reasoning}
          </pre>
        </details>
      )}
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

/**
 * Stationary reasoning/tool band. Rendered while the agent is streaming so the
 * user sees live thinking without the chat scroll moving. Max height ~6 lines;
 * fades toward the top so only the latest reasoning reads cleanly.
 */
function ThinkingBand({ streaming }: { streaming: StreamingState }) {
  const { reasoningText, toolStatus } = streaming;
  return (
    <div className="shrink-0 border-t border-white/10 bg-gradient-to-t from-black/40 to-transparent px-3 pt-2">
      <div className="relative max-h-28 overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-[var(--card)] to-transparent" />
        <div className="flex items-center gap-2 pb-1">
          <span className="inline-flex gap-1">
            <Dot delay="0ms" />
            <Dot delay="150ms" />
            <Dot delay="300ms" />
          </span>
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
            {toolStatus ? toolStatusLabel(toolStatus) : "Thinking"}
          </span>
        </div>
        {reasoningText && (
          <p className="mb-1 line-clamp-5 whitespace-pre-wrap text-[11px] italic leading-relaxed text-[var(--muted)]">
            {reasoningText}
          </p>
        )}
      </div>
    </div>
  );
}

function toolStatusLabel(s: StreamingState["toolStatus"]): string {
  if (!s) return "Thinking";
  if (s.status === "error") return `${s.title} failed`;
  if (s.status === "completed") return `${s.title} ✓`;
  return s.title;
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--muted)]"
      style={{ animationDelay: delay, animationDuration: "0.9s" }}
    />
  );
}
