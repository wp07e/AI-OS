"use client";

import { useEffect, useRef, useState } from "react";
import { useAgentChatContext } from "@/lib/hooks/AgentChatContext";
import { useGenerationBusy } from "@/lib/hooks/GenerationBusyContext";
import type { ChatMessage, StreamingState } from "@/lib/hooks/useAgentChat";
import type { BrandCardKey } from "@/lib/brand/cards";
import { BRAND_CARD_EXAMPLES, brandInputPlaceholder } from "@/lib/brand/examples";
import { WORKFLOW_EXAMPLES } from "@/lib/workflows/examples";

interface Props {
  /** Active workflow instance id, or null when nothing is selected. */
  workflowInstanceId: string | null;
  /** Active workflow type (for the panel header), or null. */
  workflowType: string | null;
  /** Active library key ("brand") when a shared library view is open, else null. */
  activeLibrary: string | null;
  /** Which brand card is currently open (drives examples + placeholder), or null. */
  activeBrandCard: BrandCardKey | null;
  /** For brand: true only after the user clicked "Ask AI" on a card. The panel
   *  stays inactive until then. Ignored for workflow lanes. */
  aiActivated: boolean;
  /** True while the active lane is being deleted — disables the input so the
   * user can't send into a doomed lane during the (slow) delete. */
  laneDeleting?: boolean;
}

/**
 * Persistent chat panel on the right of the shell. Presentational consumer of
 * the agent chat owned by AppShell (via AgentChatContext). The chat hook does
 * the transport; this component renders messages + the input and calls
 * `send()`.
 *
 * Active when a workflow lane is open, OR (brand is open AND the user has
 * clicked "Ask AI"). Brand is invite-only: until Ask AI is clicked, the panel
 * shows an inactive state and the input is disabled.
 */
export function AgentPanel({
  workflowInstanceId,
  workflowType,
  activeLibrary,
  activeBrandCard,
  aiActivated,
  laneDeleting,
}: Props) {
  const chat = useAgentChatContext();
  const genBusy = useGenerationBusy();
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const brandOpen = activeLibrary === "brand";
  // Lane chat is active as soon as a lane is open. Brand chat is active only
  // after the user clicks "Ask AI" on a card.
  const chatActive = !!workflowInstanceId || (brandOpen && aiActivated);

  // Keep the latest message in view as it arrives.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat.messages, chat.busy]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || !chatActive || laneDeleting) return;
    setInput("");
    // Steer: if the agent is mid-response, interrupt the current turn then send
    // the new message as a fresh turn in the same session (opencode's modern
    // steer model — no "steering reminder" metadata, which broke prompt caching).
    if (chat.busy) {
      chat.stop();
      // Brief tick so stop()'s cleanup (busy:false) lands before send(), else
      // send()'s busyRef guard would reject the steered message.
      await Promise.resolve();
    }
    await chat.send(text);
  }

  function onStop(e: React.MouseEvent) {
    e.preventDefault();
    chat.stop();
  }

  const headerLabel = brandOpen
    ? `brand${activeBrandCard ? ` · ${activeBrandCard}` : ""}`
    : workflowType
      ? `${workflowType} lane`
      : "Agent";

  // Examples shown when the AI is active and there's no conversation yet.
  const examples = brandOpen && activeBrandCard
    ? BRAND_CARD_EXAMPLES[activeBrandCard]
    : workflowType ? (WORKFLOW_EXAMPLES[workflowType] ?? []) : [];
  const placeholder = laneDeleting
    ? "This lane is being deleted…"
    : genBusy.busy
      ? "Generation running — type to steer or ask the agent…"
      : chat.busy
        ? "Steer the agent — type and press Enter…"
        : brandOpen
          ? brandInputPlaceholder(activeBrandCard)
          : "Message the agent…";

  return (
    <aside className="flex min-h-0 flex-col bg-[var(--card)]/20">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-white/10 px-3">
        <div className="flex items-center gap-2">
          <span className="grid h-5 w-5 place-items-center rounded-md bg-gradient-to-br from-indigo-500 to-sky-400 text-[10px] font-bold text-white">
            AI
          </span>
          <span className="text-xs font-medium tracking-tight">{headerLabel}</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1 text-[10px] text-[var(--muted)]">
            <input
              type="checkbox"
              checked={showThinking}
              onChange={(e) => setShowThinking(e.target.checked)}
              className="h-2.5 w-2.5 accent-indigo-400"
            />
            thinking
          </label>
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
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        {!chatActive ? (
          brandOpen ? (
            <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-[var(--muted)]">
              {activeBrandCard
                ? `Open the ${activeBrandCard} card and click “Ask AI” to get help here.`
                : "Open a card and click “Ask AI” to get help building your brand kit."}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-[var(--muted)]">
              Nothing selected.
              <br />
              Pick a workflow or library on the left to start.
            </div>
          )
        ) : chat.messages.length === 0 && !chat.error ? (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-xs text-[var(--muted)]">
              {brandOpen
                ? "Ask the AI to help with this card — or try an example below."
                : "Ask the AI to help with this workflow — or try an example below."}
            </div>
            {examples.length > 0 && (
              <div className="flex flex-col gap-1.5">
                {examples.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => {
                      setInput(ex);
                      requestAnimationFrame(() => inputRef.current?.focus());
                    }}
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-[11px] text-[var(--foreground)]/80 transition hover:border-indigo-400/40 hover:bg-indigo-500/10 hover:text-indigo-200"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            )}
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
      {chat.streaming && showThinking && <ThinkingBand streaming={chat.streaming} />}

      <form
        onSubmit={onSubmit}
        className="flex shrink-0 gap-2 border-t border-white/10 bg-gradient-to-t from-[var(--background)] to-transparent p-3"
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={chatActive ? placeholder : "Select a workflow or library to chat…"}
          className="flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/30 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!chatActive || laneDeleting}
        />
        {chat.busy ? (
          <button
            type="button"
            onClick={onStop}
            title="Stop the agent"
            className="flex items-center justify-center rounded-xl border border-red-400/40 bg-red-500/20 px-4 py-2.5 text-sm font-semibold text-red-200 shadow-lg shadow-red-500/10 transition hover:bg-red-500/30"
          >
            <span className="inline-block h-3 w-3 rounded-[3px] bg-red-300" aria-hidden />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim() || !chatActive || laneDeleting}
            className="rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            ↵
          </button>
        )}
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
