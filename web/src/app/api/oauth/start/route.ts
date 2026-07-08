import { currentUser } from "@/lib/auth";
import { getContainerForUser } from "@/lib/docker";
import { isCanvaConnected } from "@/lib/opencode";
import { startOauthFlow, type OauthEvent } from "@/lib/oauth-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events endpoint. Runs `docker compose exec ai-os mcp-auth Canva`
 * inside the user's container and streams parsed events to the browser:
 *   data: {"type":"log","line":"..."}
 *   data: {"type":"url","url":"https://mcp.canva.com/authorize?..."}
 *   data: {"type":"success"}
 *   data: {"type":"error","message":"..."}
 *
 * Pre-flight: if Canva is already connected, emits { type: "success" }
 * immediately and never spawns mcp-auth. This prevents a hang where
 * `opencode mcp auth` shows an unanswerable TUI "Re-authenticate?"
 * prompt when valid credentials already exist (no TTY on piped stdio).
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const row = getContainerForUser(user.id);
  if (!row) return new Response("container not launched", { status: 400 });
  if (row.status !== "ready") return new Response("container not ready", { status: 409 });

  // Pre-flight: short-circuit if Canva is already connected.
  if (await isCanvaConnected(row.opencode_port)) {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "success" } satisfies OauthEvent)}\n\n`));
        controller.close();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (e: OauthEvent) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      };

      startOauthFlow(row, send, abort.signal)
        .catch((err) => {
          send({ type: "error", message: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
