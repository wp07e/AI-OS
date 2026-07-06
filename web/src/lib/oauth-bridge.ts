import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { COMPOSE_FILE } from "./docker";
import type { ContainerRow } from "./db";

const AUTHORIZE_URL_RE = /https:\/\/mcp\.canva\.com\/authorize\?[^\s|]+/;

export type OauthEvent =
  | { type: "log"; line: string }
  | { type: "url"; url: string }
  | { type: "success" }
  | { type: "error"; message: string };

/**
 * Runs `docker compose -p <project> exec ai-os mcp-auth Canva` and emits
 * streaming events as stdout is parsed. The browser opens the authorize URL;
 * the redirect hits the published OAuth port and OpenCode completes the flow.
 *
 * The optional signal lets the caller cancel mid-flight.
 */
export function startOauthFlow(
  row: ContainerRow,
  emit: (e: OauthEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcessByStdio<null, Readable, Readable>;
    try {
      proc = spawn(
        "docker",
        [
          "compose",
          "-p",
          row.project_name,
          "-f",
          COMPOSE_FILE,
          "exec",
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
