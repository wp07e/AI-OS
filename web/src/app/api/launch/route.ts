import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getContainerForUser, launchForUser, waitForReady } from "@/lib/docker";
import { isCanvaConnected } from "@/lib/opencode";

export const runtime = "nodejs";
export const maxDuration = 300; // up to 5 min for first-launch image start

export async function POST() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const { row } = await launchForUser(user);
    // Don't block the request on readiness — the launching page polls /api/status.
    // Kick off readiness in the background; waitForReady updates the DB.
    waitForReady(row).catch((err) => console.error("[launch] readiness error", err));
    return NextResponse.json({
      ok: true,
      status: row.status,
      opencodePort: row.opencode_port,
      oauthPort: row.oauth_port,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[launch] launchForUser failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const row = getContainerForUser(user.id);
  if (!row) return NextResponse.json({ status: "none" });

  // When the container is ready, also report whether Canva is already
  // connected. The launching page uses this to decide: skip /oauth and
  // go straight to /app if connected, or route through /oauth if not.
  // This avoids a hang where `opencode mcp auth` shows an unanswerable
  // TUI "Re-authenticate?" prompt when valid credentials already exist.
  let canvaConnected = false;
  if (row.status === "ready") {
    canvaConnected = await isCanvaConnected(row.opencode_port);
  }

  return NextResponse.json({
    status: row.status,
    opencodePort: row.opencode_port,
    oauthPort: row.oauth_port,
    canvaConnected,
  });
}
