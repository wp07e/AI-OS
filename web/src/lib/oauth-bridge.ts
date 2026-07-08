import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { COMPOSE_FILE } from "./docker";
import type { ContainerRow } from "./db";

const AUTHORIZE_URL_RE = /https:\/\/mcp\.canva\.com\/authorize\?[^\s|]+/;

/** Path to the OAuth token cache inside the container (appuser's HOME). */
const MCP_AUTH_TOKEN_PATH = "/workspace/.local/share/opencode/mcp-auth.json";

export type OauthEvent =
  | { type: "log"; line: string }
  | { type: "url"; url: string }
  | { type: "success" }
  | { type: "error"; message: string };

/**
 * Runs `docker compose -p <project> exec --user 2000:2000 ai-os mcp-auth Canva`
 * (as the appuser, HOME=/workspace) and emits streaming events as stdout is
 * parsed. The browser opens the authorize URL; the redirect hits the published
 * OAuth port and OpenCode completes the flow.
 *
 * Before spawning mcp-auth, any existing token cache file is deleted. This
 * prevents `opencode mcp auth` from showing an interactive TUI
 * "Canva already has valid credentials. Re-authenticate?" prompt, which hangs
 * forever because stdio is piped (no TTY). We only reach this code path when
 * the connection is confirmed NOT working (Layers 1 and 2 short-circuit if it
 * is), so deleting a stale token loses nothing.
 *
 * The optional signal lets the caller cancel mid-flight.
 */
export function startOauthFlow(
  row: ContainerRow,
  emit: (e: OauthEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // --- Delete any stale token cache so mcp-auth runs a clean flow --------
    // If mcp-auth.json exists (even with an expired token), opencode shows an
    // unanswerable "Re-authenticate?" TUI prompt. Removing it forces a fresh
    // flow. This is safe: Layers 1+2 already confirmed the connection isn't
    // working, so there's nothing useful in the file to preserve.
    const rm = spawnSync(
      "docker",
      [
        "compose",
        "-p",
        row.project_name,
        "-f",
        COMPOSE_FILE,
        "exec",
        "--user",
        "2000:2000",
        "ai-os",
        "rm",
        "-f",
        MCP_AUTH_TOKEN_PATH,
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 },
    );
    if (rm.status !== 0) {
      // Non-fatal: the file may simply not exist (first-time OAuth).
      // Log but continue — the flow should still work.
      const stderr = rm.stderr?.toString().trim();
      if (stderr) emit({ type: "log", line: `[cleanup] rm note: ${stderr}` });
    }

    let proc: ChildProcessByStdio<null, Readable, Readable>;
    try {
      // Run mcp-auth AS THE APPUSER (uid 2000, HOME=/workspace) — not as root.
      // `docker compose exec` defaults to the container's configured user,
      // which is root here (the service has no `user:` directive; the
      // entrypoint's gosu drop only applies to the main CMD). If mcp-auth runs
      // as root, `opencode mcp auth` writes the completed token to
      // /root/.local/share/opencode/mcp-auth.json, but `opencode serve` runs as
      // appuser and reads /workspace/.local/share/opencode/mcp-auth.json — so
      // Canva would report needs_auth forever. Forcing the exec user + HOME
      // makes the token land where serve reads it.
      proc = spawn(
        "docker",
        [
          "compose",
          "-p",
          row.project_name,
          "-f",
          COMPOSE_FILE,
          "exec",
          "--user",
          "2000:2000",
          "--env",
          "HOME=/workspace",
          "ai-os",
          "mcp-auth",
          "Canva",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e) {
      reject(e);
      return;
    }

    const onAbort = () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let stderrBuf = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        const trimmed = line.trimEnd();
        if (!trimmed) continue;

        const match = trimmed.match(AUTHORIZE_URL_RE);
        if (match) {
          // Strip trailing box-drawing chars opencode appends.
          const url = match[0].replace(/[│●]/g, "").trim();
          emit({ type: "url", url });
        } else {
          emit({ type: "log", line: trimmed });
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    proc.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      emit({ type: "error", message: err.message });
      reject(err);
    });

    proc.on("exit", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        emit({ type: "error", message: "cancelled" });
        return resolve();
      }
      if (code === 0) {
        emit({ type: "success" });
        resolve();
      } else {
        const message = `mcp-auth exited with code ${code}` + (stderrBuf ? `: ${stderrBuf.trim()}` : "");
        emit({ type: "error", message });
        reject(new Error(message));
      }
    });
  });
}
