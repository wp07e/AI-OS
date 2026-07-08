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

interface RelayInfo {
  token: string;
  server: string;
  oauthPort: number;
}

/* ------------------------------------------------------------------ */
/*  Tiny copy-to-clipboard block used inside each OS <details>       */
/* ------------------------------------------------------------------ */
function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function doCopy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for insecure contexts
      const ta = document.createElement("textarea");
      ta.value = command;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="group/cmd relative">
      <pre className="mt-0.5 rounded bg-black/40 p-1.5 pr-16 font-mono text-[10px] text-amber-100/90 overflow-x-auto whitespace-pre-wrap">
        <code>{command}</code>
      </pre>
      <button
        type="button"
        onClick={doCopy}
        className="absolute right-1.5 top-1.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-medium text-amber-200 opacity-0 transition group-hover/cmd:opacity-100 hover:bg-amber-500/40"
      >
        {copied ? "✓ Copied" : "Copy"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main page component                                               */
/* ------------------------------------------------------------------ */
export default function OauthPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("intro");
  const [logs, setLogs] = useState<string[]>([]);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [relayInfo, setRelayInfo] = useState<RelayInfo | null>(null);

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
        setPhase("restarting");
        restartAndContinue();
      } else if (ev.type === "error") {
        setError(ev.message ?? "OAuth failed.");
        setPhase("error");
        es.close();
      }
    };
    es.onerror = () => {
      es.close();
      setPhase((p) => (p === "running" ? "error" : p));
    };
  }

  async function fetchRelayToken() {
    try {
      const res = await fetch("/api/oauth/relay-token");
      if (res.ok) {
        const data = (await res.json()) as RelayInfo;
        setRelayInfo(data);
      }
      // If it fails (401, 409), just don't show the relay panel.
      // The user may be running locally and doesn't need it.
    } catch {
      // Network error — ignore silently
    }
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

  /** macOS / Linux: curl downloads the script inline, then python3 runs it. */
  function buildUnixCommand(info: RelayInfo): string {
    return `cd /tmp && curl -fsSLO https://github.com/anomalyco/ai-os/raw/main/scripts/canva-oauth-relay.py && python3 canva-oauth-relay.py --port ${info.oauthPort} --server ${info.server} --token ${info.token}`;
  }

  /** Windows: PowerShell downloads via Invoke-WebRequest, then python runs it. */
  function buildWindowsCommand(info: RelayInfo): string {
    return `cd $env:TEMP; Invoke-WebRequest -Uri "https://github.com/anomalyco/ai-os/raw/main/scripts/canva-oauth-relay.py" -OutFile "canva-oauth-relay.py"; python canva-oauth-relay.py --port ${info.oauthPort} --server ${info.server} --token ${info.token}`;
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
              onClick={() => {
                start();
                fetchRelayToken();
              }}
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
            {/* --- Remote helper instructions (only shown when relay info available) --- */}
            {relayInfo && (
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-4 text-sm">
                <p className="font-medium text-amber-200">
                  🖥 Extra step needed
                </p>
                <p className="mt-1 text-xs text-amber-100/80">
                  Canva requires a <strong>small helper script</strong> running on your computer
                  to catch the authorization callback. Pick your operating system below, copy the
                  command, and paste it into a terminal. The script downloads itself automatically
                  — you don&apos;t need to save anything manually.
                </p>

                {/* --- OS-specific commands --- */}
                <div className="mt-3 space-y-2">
                  {/* macOS */}
                  <details className="group">
                    <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-amber-100/80 hover:text-amber-100">
                      🍎 macOS
                    </summary>
                    <div className="mt-1 rounded bg-black/50 p-2">
                      <ol className="list-decimal list-inside space-y-1.5 text-[10px] text-amber-100/70">
                        <li>
                          Open <strong>Terminal</strong> (press{" "}
                          <kbd className="rounded border border-white/20 bg-black/60 px-1">⌘</kbd>
                          {" + "}
                          <kbd className="rounded border border-white/20 bg-black/60 px-1">Space</kbd>
                          , type <code className="bg-black/60 px-1 rounded">Terminal</code>, press Enter)
                        </li>
                        <li>
                          Paste this command and press Enter:
                          <CommandBlock command={buildUnixCommand(relayInfo)} />
                        </li>
                      </ol>
                    </div>
                  </details>

                  {/* Windows */}
                  <details className="group">
                    <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-amber-100/80 hover:text-amber-100">
                      🪟 Windows
                    </summary>
                    <div className="mt-1 rounded bg-black/50 p-2">
                      <ol className="list-decimal list-inside space-y-1.5 text-[10px] text-amber-100/70">
                        <li>
                          Open <strong>PowerShell</strong> (click Start, type{" "}
                          <code className="bg-black/60 px-1 rounded">PowerShell</code>, press Enter)
                        </li>
                        <li>
                          Paste this command and press Enter:
                          <CommandBlock command={buildWindowsCommand(relayInfo)} />
                        </li>
                        <li>
                          If you get an &quot;execution policy&quot; error, run this first:
                          <CommandBlock command="Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass" />
                        </li>
                      </ol>
                    </div>
                  </details>

                  {/* Linux */}
                  <details className="group">
                    <summary className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-amber-100/80 hover:text-amber-100">
                      🐧 Linux
                    </summary>
                    <div className="mt-1 rounded bg-black/50 p-2">
                      <ol className="list-decimal list-inside space-y-1.5 text-[10px] text-amber-100/70">
                        <li>
                          Open a <strong>terminal</strong> (Ctrl+Alt+T on most distros)
                        </li>
                        <li>
                          Paste this command and press Enter:
                          <CommandBlock command={buildUnixCommand(relayInfo)} />
                        </li>
                      </ol>
                    </div>
                  </details>
                </div>

                {/* --- Next step: authorize --- */}
                <div className="mt-3 rounded bg-black/30 p-2.5">
                  <p className="text-xs font-medium text-amber-200">
                    What happens next
                  </p>
                  <p className="mt-1 text-[11px] text-amber-100/70">
                    The terminal will say <em>&quot;Waiting for Canva OAuth redirect…&quot;</em>.{" "}
                    Leave it running. Then click <strong>&quot;Open in Browser&quot;</strong> below
                    to approve at Canva. The helper catches the response automatically — you&apos;ll
                    see &quot;✓ Canva Authorized&quot; in the terminal, and you can close it.
                  </p>
                </div>
              </div>
            )}

            {/* --- Authorize URL --- */}
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
                onClick={() => {
                  start();
                  fetchRelayToken();
                }}
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
