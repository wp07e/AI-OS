"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Phase = "intro" | "running" | "success" | "restarting" | "error";

interface OauthEvent {
  type: "log" | "url" | "success" | "error";
  line?: string;
  url?: string;
  message?: string;
}

export default function OauthPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("intro");
  const [logs, setLogs] = useState<string[]>([]);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function appendLog(line: string) {
    setLogs((prev) => [...prev.slice(-100), line]);
  }

  function start() {
    setPhase("running");
    setLogs([]);
    setAuthorizeUrl(null);
    setError(null);

    const es = new EventSource("/api/oauth/start");
    es.onmessage = (e) => {
      let ev: OauthEvent;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev.type === "log" && ev.line) appendLog(ev.line);
      else if (ev.type === "url" && ev.url) setAuthorizeUrl(ev.url);
      else if (ev.type === "success") {
        es.close();
        // OAuth tokens are now on disk, but opencode only registers the Canva
        // MCP on a fresh process start. Restart the container so the agent can
        // actually see Canva, then head to /app.
        setPhase("restarting");
        restartAndContinue();
      } else if (ev.type === "error") {
        setError(ev.message ?? "OAuth failed.");
        setPhase("error");
        es.close();
      }
    };
    es.onerror = () => {
      // Browser may also close when the stream ends; only fail if we never got URL/success.
      es.close();
      setPhase((p) => (p === "running" ? "error" : p));
    };
  }

  async function restartAndContinue() {
    try {
      const res = await fetch("/api/oauth/restart", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        throw new Error(data.detail ? `${data.error ?? "restart failed"} — ${data.detail}` : data.error ?? "restart failed");
      }
      router.replace("/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : "restart failed");
      setPhase("error");
    }
  }

  // Auto-start once on mount (intro page still shown briefly while user reads).
  // We keep the intro so the user has explicit consent; OK triggers start().

  async function copy() {
    if (!authorizeUrl) return;
    await navigator.clipboard.writeText(authorizeUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function openInBrowser() {
    if (!authorizeUrl) return;
    window.open(authorizeUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[var(--card)]/80 p-8 shadow-2xl backdrop-blur">
        <div className="mb-5 flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-cyan-400 to-indigo-500 shadow" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Authorize Canva</h1>
            <p className="text-xs text-[var(--muted)]">One-time MCP connection</p>
          </div>
        </div>

        {phase === "intro" && (
          <div className="space-y-4 text-sm text-[var(--foreground)]/90">
            <p>
              To use Canva automation tools, your environment needs to complete the Canva OAuth
              process. After you press <strong>OK</strong>, we&apos;ll start the OAuth flow inside
              your container and give you a link to open in your browser.
            </p>
            <p className="text-[var(--muted)]">
              You&apos;ll be redirected to Canva, asked to approve access, then sent back here
              automatically.
            </p>
            <button
              onClick={start}
              className="w-full rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400"
            >
              OK, start
            </button>
            <button
              onClick={() => router.replace("/app")}
              className="w-full rounded-lg border border-white/10 px-4 py-2 text-sm font-medium hover:bg-white/5"
            >
              Skip for now
            </button>
          </div>
        )}

        {phase === "running" && (
          <div className="space-y-4">
            {authorizeUrl ? (
              <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/5 p-4 text-sm">
                <p className="font-medium text-emerald-200">Authorize in your browser:</p>
                <p className="mt-1 break-all rounded bg-black/40 p-2 font-mono text-xs text-emerald-100/90">
                  {authorizeUrl}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    onClick={openInBrowser}
                    className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-400"
                  >
                    Open in Browser
                  </button>
                  <button
                    onClick={copy}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/5"
                  >
                    {copied ? "Copied!" : "Copy link"}
                  </button>
                </div>
                <p className="mt-3 text-xs text-[var(--muted)]">Waiting for authorization…</p>
              </div>
            ) : (
              <p className="text-sm text-[var(--muted)]">Starting OAuth flow…</p>
            )}

            <div className="max-h-40 overflow-auto rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs text-[var(--muted)]">
              {logs.length === 0 ? (
                <span>waiting for output…</span>
              ) : (
                logs.map((l, i) => <div key={i}>{l}</div>)
              )}
            </div>
          </div>
        )}

        {phase === "success" && (
          <div className="space-y-2 text-sm">
            <p className="font-medium text-emerald-200">Canva connected successfully.</p>
            <p className="text-[var(--muted)]">Redirecting to your tools…</p>
          </div>
        )}

        {phase === "restarting" && (
          <div className="space-y-2 text-sm">
            <p className="font-medium text-emerald-200">Canva connected.</p>
            <p className="text-[var(--muted)]">
              Restarting your environment so the agent can see Canva…
            </p>
            <p className="text-xs text-[var(--muted)]">This takes a few seconds.</p>
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-4 text-sm">
            <p className="rounded-md bg-red-500/10 px-3 py-2 text-red-300">
              {error ?? "OAuth failed."}
            </p>
            <div className="flex gap-2">
              <button
                onClick={start}
                className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-400"
              >
                Try again
              </button>
              <button
                onClick={() => router.replace("/app")}
                className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium hover:bg-white/5"
              >
                Continue anyway
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
