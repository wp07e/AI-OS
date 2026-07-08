import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getContainerForUser } from "@/lib/docker";
import { isCanvaConnected } from "@/lib/opencode";

export const runtime = "nodejs";

/**
 * GET /api/canva/status
 *
 * Returns whether the user's container has a working Canva MCP connection.
 * The single client-facing source of connection truth — the canvas uses this
 * to gate Canva-dependent workflows (e.g. Carousel Studio) and to show the
 * "Connect Canva" affordance in the header. Derived live from the opencode
 * server's /mcp endpoint; no DB flag is stored.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const container = getContainerForUser(user.id);
  if (!container || container.status !== "ready") {
    // No ready container → not connected. The shell redirects to /launching in
    // this case; report false so any race doesn't falsely enable a gate.
    return NextResponse.json({ connected: false });
  }

  const connected = await isCanvaConnected(container.opencode_port);
  return NextResponse.json({ connected });
}
