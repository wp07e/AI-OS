import { NextResponse } from "next/server";
import { getContainerForUser } from "@/lib/docker";
import { consumeRelayToken } from "@/lib/relay-tokens";

export const runtime = "nodejs";

/**
 * POST /api/oauth/relay
 *
 * Receives a Canva OAuth callback relayed from the user's local Python helper.
 * The helper catches Canva's loopback redirect (127.0.0.1:<port>) on the user's
 * laptop, then POSTs the raw path + query here.
 *
 * This route:
 *   1. Validates the Bearer token (single-use, minted by /api/oauth/relay-token).
 *   2. Resolves the token to a userId → container row → oauth_port.
 *   3. Replays the OAuth callback as:  GET http://127.0.0.1:<oauth_port><path>?<query>
 *      This traverses the existing socat relay (container:RELAY_PORT → OpenCode
 *      loopback:OAUTH_PORT), where OpenCode validates `state`, exchanges the
 *      code for a token using its PKCE verifier, and writes mcp-auth.json.
 *   4. Returns OpenCode's response to the helper.
 *
 * The token itself never crosses this route — only the short-lived authorization
 * code, which is useless without the PKCE verifier held inside the container.
 *
 * Request headers:
 *   Authorization: Bearer <token>
 *
 * Request body (JSON):
 *   { "path": "/mcp/oauth/callback", "query": "code=…&state=…" }
 */
export async function POST(req: Request) {
  // --- Authenticate via bearer token ------------------------------------
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "missing or invalid Authorization header" }, { status: 401 });
  }
  const token = authHeader.slice("Bearer ".length);

  const userId = consumeRelayToken(token);
  if (userId === null) {
    return NextResponse.json(
      { error: "invalid, expired, or already-used relay token" },
      { status: 401 },
    );
  }

  // --- Parse the relay payload -------------------------------------------
  let body: { path?: string; query?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { path, query } = body;
  if (!path || typeof path !== "string") {
    return NextResponse.json({ error: "missing 'path'" }, { status: 400 });
  }
  if (!query || typeof query !== "string") {
    return NextResponse.json({ error: "missing 'query'" }, { status: 400 });
  }

  // --- Look up the user's container --------------------------------------
  const row = getContainerForUser(userId);
  if (!row || row.status !== "ready") {
    return NextResponse.json({ error: "no ready container for user" }, { status: 409 });
  }

  // --- Replay the callback into the container's OpenCode ------------------
  //
  // Construct the exact URL the browser would have hit locally:
  //   http://127.0.0.1:<oauth_port>/mcp/oauth/callback?code=…&state=…
  //
  // On this host, <oauth_port> is published by Docker Compose as:
  //   0.0.0.0:<oauth_port> → container:<relay_port> (socat)
  //                    → 127.0.0.1:<oauth_port> (OpenCode loopback)
  //
  // The fetch traverses this chain; OpenCode handles the rest.

  const targetUrl = `http://127.0.0.1:${row.oauth_port}${path}?${query}`;

  console.log(
    `[relay] userId=${userId} container=${row.project_name} ` +
    `replaying to ${targetUrl}`,
  );

  try {
    const resp = await fetch(targetUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });

    const respBody = await resp.text();

    console.log(
      `[relay] OpenCode responded ${resp.status} ` +
      `(body: ${respBody.substring(0, 200)}${respBody.length > 200 ? "…" : ""})`,
    );

    return new Response(respBody, {
      status: resp.status,
      headers: { "Content-Type": resp.headers.get("content-type") || "text/plain" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[relay] Failed to reach OpenCode: ${message}`);
    return NextResponse.json(
      { error: "failed to reach container OpenCode", detail: message },
      { status: 502 },
    );
  }
}
