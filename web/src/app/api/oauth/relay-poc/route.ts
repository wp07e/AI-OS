import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * POST /api/oauth/relay-poc
 *
 * ━━━ POC BUILD — TEMPORARY, WILL BE REPLACED BY /api/oauth/relay ━━━
 *
 * Receives a Canva OAuth callback relayed from the user's local Python helper.
 * The helper catches Canva's loopback redirect (127.0.0.1:<port>) on the user's
 * laptop, then POSTs the raw path + query here.
 *
 * This route replays the request into the container's OpenCode process by
 * fetching  http://127.0.0.1:<oauth_port><path>?<query>  — the exact same
 * request the browser would have made locally.  It traverses the existing
 * socat relay (container:19801 → 127.0.0.1:19800) into OpenCode's loopback
 * listener, which validates `state`, exchanges the code for a token using its
 * PKCE verifier, and writes mcp-auth.json.
 *
 * ━━━ SECURITY: POC only — no auth check.  Anyone who can reach this endpoint
 * can replay a callback into any container.  The production version
 * (/api/oauth/relay) will require a single-use bearer token that maps to a
 * specific user + container.  This POC route should be deleted after
 * validation.
 *
 * Request body (JSON):
 *   {
 *     "path":  "/mcp/oauth/callback",   // the redirect path
 *     "query": "code=ABC&state=XYZ",     // the redirect query string
 *     "oauth_port": 19800                 // container's OAUTH_PORT on this host
 *   }
 */

export async function POST(req: Request) {
  // --- Parse the relay payload ---------------------------------------------
  let body: { path?: string; query?: string; oauth_port?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { path, query, oauth_port } = body;

  // Validate required fields
  if (!path || typeof path !== "string") {
    return NextResponse.json({ error: "missing 'path'" }, { status: 400 });
  }
  if (!query || typeof query !== "string") {
    return NextResponse.json({ error: "missing 'query'" }, { status: 400 });
  }
  if (!oauth_port || typeof oauth_port !== "number" || oauth_port < 1 || oauth_port > 65535) {
    return NextResponse.json({ error: "missing or invalid 'oauth_port'" }, { status: 400 });
  }

  // --- Replay the request into the container's OpenCode ---------------------
  //
  // This is the KEY LINE.  We construct the exact URL that the browser
  // would have hit locally:
  //   http://127.0.0.1:19800/mcp/oauth/callback?code=…&state=…
  //
  // On this host, port 19800 is published by Docker Compose as:
  //   0.0.0.0:19800 → container:19801 (socat) → 127.0.0.1:19800 (OpenCode)
  //
  // So this fetch traverses the existing socat relay and reaches OpenCode's
  // loopback OAuth listener.  OpenCode then does the code→token exchange
  // using its own PKCE verifier (which never left the container).

  const targetUrl = `http://127.0.0.1:${oauth_port}${path}?${query}`;

  console.log(`[relay-poc] Replaying to: ${targetUrl}`);

  try {
    const resp = await fetch(targetUrl, {
      method: "GET",
      // Don't follow redirects — OpenCode handles the callback directly.
      redirect: "manual",
      // Short timeout — the token exchange should complete in seconds.
      signal: AbortSignal.timeout(15_000),
    });

    // Forward OpenCode's response back to the helper, which renders it
    // in the user's browser.  This way, if OpenCode returns a success
    // page, the user sees it locally.
    const respBody = await resp.text();

    console.log(
      `[relay-poc] OpenCode responded ${resp.status} ` +
      `(body: ${respBody.substring(0, 200)}${respBody.length > 200 ? "…" : ""})`,
    );

    return new Response(respBody, {
      status: resp.status,
      headers: { "Content-Type": resp.headers.get("content-type") || "text/plain" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[relay-poc] Failed to reach OpenCode: ${message}`);
    return NextResponse.json(
      { error: "failed to reach container OpenCode", detail: message },
      { status: 502 },
    );
  }
}
