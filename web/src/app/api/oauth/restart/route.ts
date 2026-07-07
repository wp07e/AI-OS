import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getContainerForUser, restartForUser, waitForReady } from "@/lib/docker";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * POST /api/oauth/restart
 *
 * Restarts the user's container after Canva OAuth completes. opencode only
 * registers the Canva MCP on a fresh process start; without a restart the
 * tokens are on disk but the running agent can't see Canva. Waits for the
 * server to come back healthy AND for Canva to report `connected` before
 * responding, so the client can navigate to /app knowing the agent actually
 * has Canva (not just that opencode booted — MCP connections lag health by a
 * few seconds after restart).
 *
 * Returns { ok: true } on success, { error } with 502 if the restart fails,
 * the server doesn't come back, or Canva never connects.
 */
export async function POST() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    await restartForUser(user.id);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "restart failed", detail }, { status: 502 });
  }

  const row = getContainerForUser(user.id);
  if (!row) {
    return NextResponse.json({ error: "no container after restart" }, { status: 502 });
  }

  const ready = await waitForReady(row, { timeoutMs: 120_000, intervalMs: 1500 });
  if (!ready) {
    return NextResponse.json({ error: "container did not become ready" }, { status: 502 });
  }

  // Health comes up before MCP connections finish initializing. Poll /mcp until
  // Canva reports connected (or a short timeout) so we don't send the user to
  // /app in the brief window where the agent can't yet see Canva.
  const canvaReady = await waitForCanvaConnected(row.opencode_port, 30_000);
  if (!canvaReady) {
    return NextResponse.json({ error: "Canva MCP did not connect after restart" }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}

/** Polls GET /mcp until the Canva entry reports status "connected". */
async function waitForCanvaConnected(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Optional HTTP Basic auth if OPENCODE_SERVER_PASSWORD is set (matches the
  // opencode.ts client). Most dev setups leave it unset.
  const pwd = process.env.OPENCODE_SERVER_PASSWORD;
  const headers = pwd ? { Authorization: `Basic ${Buffer.from(`opencode:${pwd}`).toString("base64")}` } : undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, { headers });
      if (res.ok) {
        const data = (await res.json()) as Record<string, { status?: string }>;
        if (data?.Canva?.status === "connected") return true;
      }
    } catch {
      // server briefly unreachable mid-restart — keep polling
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
