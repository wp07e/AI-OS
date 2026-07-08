"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

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

const GITHUB_RAW =
  "https://github.com/wp07e/AI-OS/raw/main/scripts/canva-oauth-relay.py";
const GITHUB_BLOB =
  "https://github.com/wp07e/AI-OS/blob/main/scripts/canva-oauth-relay.py";

/* ------------------------------------------------------------------ */
/*  Tiny copy-to-clipboard block used inside each OS <details>        */
/* ------------------------------------------------------------------ */
function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function doCopy() {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // Fallback for insecure contexts (HTTP localhost dev)
      const ta = document.createElement("textarea");
      ta.value = command;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="group/cmd relative">
      <pre className="mt-0.5 rounded bg-black/40 p-1.5 pr-16 font-mono text-[10px] text-amber-100/90 overflow-x-auto whitespace-pre-wrap break-all">
        <code>{command}</code>
      </pre>
      <button
        type="button"
        onClick={doCopy}
        className="absolute right-1.5 top-1.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-medium text-amber-200 opacity-60 transition hover:bg-amber-500/40 hover:opacity-100"
      >
        {copied ? "✓ Copied" : "Copy"}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main page component                                                */
/* ------------------------------------------------------------------ */
export default function OauthPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("intro");
  const [logs, setLogs] = useState<string[]>([]);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [relayInfo, setRelayInfo] = useState<RelayInfo | null>(null);
  const [helperReady, setHelperReady] = useState(false);

  // Fetch relay token on mount so the intro page can show the exact
  // command the user should run — well before the OAuth timer starts.
  useEffect(() => {
    fetchRelayToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function appendLog(line: string) {
    setLogs((prev) => [...prev.slice(-100), line]);
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

  async function restartAndContinue() {
    try {
      const res = await fetch("/api/oauth/restart", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
        throw new Error(
          data.detail
            ? `${data.error ?? "restart failed"} — ${data.detail}`
            : data.error ?? "restart failed",
        );
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
    return `cd /tmp && curl -fsSLO ${GITHUB_RAW} && python3 canva-oauth-relay.py --port ${info.oauthPort} --server ${info.server} --token ${info.token}`;
  }

  /** Windows: PowerShell downloads via Invoke-WebRequest, then python runs it. */
  function buildWindowsCommand(info: RelayInfo): string {
    return `cd $env:TEMP; Invoke-WebRequest -Uri "${GITHUB_RAW}" -OutFile "canva-oauth-relay.py"; python canva-oauth-relay.py --port ${info.oauthPort} --server ${info.server} --token ${info.token}`;
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
              To use Canva automation tools, your environment needs to complete the{" "}
              <strong>Canva OAuth</strong> process. To bypass{" "}
              <a
                href="https://www.canva.dev/docs/mcp/#1-register-your-redirect-uri"
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-400 underline underline-offset-2 hover:text-indigo-300"
              >
                Canva OAuth restrictions
              </a>
              , you will need to run a <strong>tiny bridge helper</strong> program on your computer.
              This is a <strong>one-time step</strong> and will only be needed anytime you need a
              new Canva OAuth token.
            </p>
            <p>
              Once started, the flow has a <strong>strict timeout</strong> — so please read this
              whole page and <strong>get the helper running before you press &quot;Start&quot;</strong>.
            </p>

            {/* ---- Security / trust ---- */}
            <div className="rounded-lg border border-emerald-400/30 bg-emerald-400/5 p-4 text-xs text-emerald-100/80">
              <p className="font-medium text-emerald-200">🔒 This script captures no secrets</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 leading-relaxed">
                <li>
                  The code is open source and uses only the Python standard library (no
                  third-party packages).{" "}
                  <a
                    href={GITHUB_BLOB}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-emerald-300 underline underline-offset-2 hover:text-emerald-200"
                  >
                    Read it on GitHub →
                  </a>
                </li>
              </ul>
              <p className="mt-2 text-[var(--muted)]">
                <strong className="text-emerald-100/90">Requires Python 3.</strong> Mac and Linux
                ship with it. Windows users: if you don&apos;t have it,{" "}
                <a
                  href="https://www.python.org/downloads/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-300 underline underline-offset-2 hover:text-emerald-200"
                >
                  download it from python.org
                </a>{" "}
                (free) and re-open PowerShell after installing.
              </p>
            </div>

            {/* ---- OS-specific copy-paste commands ---- */}
            {relayInfo ? (
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-4 text-sm">
                <p className="font-medium text-amber-200">🖥 Run the helper (before starting)</p>
                <p className="mt-1 text-xs text-amber-100/80">
                  Pick your operating system, copy the command, and paste it into a terminal. The
                  script downloads itself automatically — you don&apos;t need to save anything by
                  hand. Once it prints &quot;Waiting for Canva OAuth redirect…&quot; it&apos;s
                  ready; leave it running.
                </p>

                <div className="mt-3 space-y-2">
                  {/* macOS */}
                  <details className="group" open>
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
                          , type <code className="bg-black/60 px-1 rounded">Terminal</code>, press
                          Enter)
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

                {/* Helper-ready checkbox */}
                <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-amber-100/80">
                  <input
                    type="checkbox"
                    checked={helperReady}
                    onChange={(e) => setHelperReady(e.target.checked)}
                    className="mt-0.5 h-3.5 w-3.5 rounded border-amber-400/50 bg-black/30"
                  />
                  <span>
                    I&apos;ve started the helper and it says &quot;Waiting for Canva OAuth
                    redirect…&quot;
                  </span>
                </label>
              </div>
            ) : (
            <p className="text-xs text-[var(--muted)]">
              If you&apos;re running locally on this machine you don&apos;t need the helper.
            </p>
            )}

            <button
              onClick={start}
              className="w-full rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={relayInfo ? !helperReady : false}
            >
              {relayInfo && !helperReady ? "Check the box when helper is running" : "Start OAuth"}
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
            {/* Compact reminder that the helper should already be running */}
            {relayInfo && (
              <p className="rounded-md border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-100/70">
                Reminder: your helper should be running and waiting for the redirect. Approve at
                Canva below — it catches the callback automatically.
              </p>
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
                  setHelperReady(false);
                  setPhase("intro");
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
