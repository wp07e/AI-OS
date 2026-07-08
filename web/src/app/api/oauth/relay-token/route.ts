import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { currentUser } from "@/lib/auth";
import { getContainerForUser } from "@/lib/docker";
import { mintRelayToken } from "@/lib/relay-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/oauth/relay-token
 *
 * Mints a single-use, short-lived bearer token that the local Python helper
 * script uses to authenticate relay requests to /api/oauth/relay.
 *
 * The response includes everything the UI needs to render the exact run command:
 *   - token:     the bearer string
 *   - server:    the public base URL of this server (derived from Host header)
 *   - oauthPort: the user's container OAUTH_PORT (for the --port arg)
 *
 * Auth: requires a valid session cookie (same as all /api/* routes).
 *
 * Returns 401 if not logged in, 409 if no container is running for the user.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return NextResponse.json({ error: "no ready container" }, { status: 409 });
  }

  // Derive the public server URL from the request's Host header.
  // In production behind nginx with TLS, the Host header is the public
  // domain (e.g. os.abdspros.com).  We prepend "https://" since nginx
  // redirects HTTP → HTTPS and the helper must use HTTPS.
  const headersList = await headers();
  const host = headersList.get("host") || "localhost:3000";
  const proto = headersList.get("x-forwarded-proto") || "https";
  const server = `${proto}://${host}`;

  // Mint a single-use bearer token tied to this user.
  const token = mintRelayToken(user.id);

  return NextResponse.json({
    token,
    server,
    oauthPort: row.oauth_port,
  });
}
