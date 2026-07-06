"use client";

import { useState } from "react";

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

export default function AppHome() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    setError(null);
    setBusy(true);
    setInput("");

    const userMsg: Message = { id: Date.now(), role: "user", content: text };
    setMessages((m) => [...m, userMsg]);

    try {
      const res = await fetch("/api/tools/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
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

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Tools</h1>
          <p className="text-sm text-[var(--muted)]">Send a message to your AI container.</p>
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--muted)]">
          <input
            type="checkbox"
            checked={showDebug}
            onChange={(e) => setShowDebug(e.target.checked)}
            className="h-3 w-3 accent-indigo-400"
          />
          Show raw parts
        </label>
      </div>

      {messages.length === 0 && !error && (
        <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-8 text-center text-sm text-[var(--muted)]">
          No messages yet. Type below to get started.
        </div>
      )}

      <div className="flex flex-col gap-3">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} showDebug={showDebug} />
        ))}
        {busy && (
          <div className="self-start rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-[var(--muted)]">
            <span className="inline-flex gap-1">
              <Dot delay="0ms" />
              <Dot delay="150ms" />
              <Dot delay="300ms" />
            </span>
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>
      )}

      <form
        onSubmit={send}
        className="sticky bottom-0 mt-auto flex gap-2 bg-gradient-to-t from-[var(--background)] via-[var(--background)]/95 to-transparent pt-4"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message your AI container…"
          className="flex-1 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm outline-none transition focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-400/30"
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-xl bg-indigo-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Sending…" : "Enter"}
        </button>
      </form>
    </main>
  );
}

function MessageBubble({ message, showDebug }: { message: Message; showDebug: boolean }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex flex-col gap-1.5 ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-500/90 px-4 py-2 text-sm text-white shadow-md shadow-indigo-500/20"
            : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm"
        }
      >
        {message.content}
      </div>
      {!isUser && message.response?.raw?.parts && showDebug && (
        <details className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs">
          <summary className="cursor-pointer text-[var(--muted)]">
            raw parts ({message.response.raw.parts.length})
          </summary>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-[var(--muted)]">
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
