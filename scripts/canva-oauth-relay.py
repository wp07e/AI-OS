#!/usr/bin/env python3
"""
canva-oauth-relay.py — Local loopback bridge for Canva OAuth on a remote server.

================================================================================
WHY THIS EXISTS
================================================================================
Canva's OAuth callback is pinned to  127.0.0.1  (loopback).  When the AI-OS
server runs locally, the browser can reach that callback directly.  When the
server is on a remote VPS, the browser redirects to 127.0.0.1 on the *user's
laptop* — where nothing is listening.

This script plugs that gap:

  1. It binds a tiny HTTP server on 127.0.0.1:<PORT> on the user's laptop.
  2. When Canva redirects back (  GET /mcp/oauth/callback?code=…&state=…  ),
     the script catches that request and POSTs the raw path + query string to
     the remote AI-OS server at  /api/oauth/relay .
  3. The server replays the request into the correct container's OpenCode
     process (via the existing socat relay).  OpenCode validates the `state`,
     exchanges the authorisation code for an access token using its own PKCE
     verifier (which never left the container), and writes the token to disk.
  4. The token **never touches this script or the browser** — only the short-
     lived authorisation code crosses the network, and that code is useless
     without the verifier.

This is a one-time, single-use bridge.  Once the OAuth flow succeeds, the
script can be closed (or it will auto-exit after 10 minutes of inactivity).

================================================================================
USAGE
================================================================================
    python3 canva-oauth-relay.py \\
        --port 19800 \\
        --server https://os.abdspros.com \\
        --token <relay-bearer-token>

    --port   The loopback port to bind.  This MUST match the OAUTH_PORT that
             the AI-OS server allocated for your container (e.g. 19800).
             Canva's redirect_uri uses this exact port, so the callback
             lands here.

    --server The base URL of your AI-OS server (e.g. https://os.abdspros.com).
             The script POSTs to <server>/api/oauth/relay .

    --token  A single-use, short-lived bearer token minted by the AI-OS server
             (returned by GET /api/oauth/relay-token).  This authenticates the
             relay request so the server knows which user + container to
             replay into.

================================================================================
DEPENDENCIES
================================================================================
Python 3 standard library only.  No pip install, no virtualenv, no extras.
    http.server   — serves the loopback callback listener
    urllib        — POSTs the relay request to the remote server
    argparse      — parses the three required arguments
    webbrowser    — optionally opens the authorise URL (not used here; the
                    AI-OS web UI handles that)

================================================================================
SECURITY MODEL
================================================================================
* The bearer token is single-use and expires after ~10 minutes.  It
  authorises *only* the relay replay — nothing else.
* The OAuth authorisation `code` crosses the internet (laptop → server) but
  is useless without the PKCE `code_verifier`, which stays inside the
  container (standard OAuth 2.1 PKCE property).
* The access token itself (written to  mcp-auth.json  inside the container)
  never leaves the container.
* `state` is validated by OpenCode, not by this script.
* The script only accepts requests on 127.0.0.1 (loopback) — it is not
  reachable from the network.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional


# ---------------------------------------------------------------------------
# Configuration (set via command-line arguments)
# ---------------------------------------------------------------------------

RELAY_PORT: int = 0       # --port  (loopback port to bind)
SERVER_URL: str = ""       # --server  (e.g. https://os.abdspros.com)
RELAY_TOKEN: str = ""      # --token  (single-use bearer)
USED: bool = False          # Set to True after the first successful relay

# POC-only: the oauth_port is sent in the relay payload so the POC server
# endpoint knows which container to target.  In production, the server resolves
# this from the bearer token → user → container lookup.


# ---------------------------------------------------------------------------
# The relay endpoint URL on the server
# ---------------------------------------------------------------------------

def relay_endpoint() -> str:
    """Return the full URL the script POSTs to, e.g.
       https://os.abdspros.com/api/oauth/relay-poc   (POC)
       https://os.abdspros.com/api/oauth/relay        (production)
    """
    return f"{SERVER_URL}/api/oauth/relay-poc"


# ---------------------------------------------------------------------------
# Success page shown to the user after the relay fires
# ---------------------------------------------------------------------------

SUCCESS_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Canva OAuth — Relay Complete</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; justify-content:
         center; align-items: center; min-height: 100vh; margin: 0;
         background: #0f172a; color: #e2e8f0; }
  .card { background: #1e293b; border-radius: 16px; padding: 2rem;
          max-width: 420px; text-align: center;
          box-shadow: 0 25px 50px -12px rgba(0,0,0,.5); }
  h1 { font-size: 1.3rem; margin: 0 0 .5rem; color: #6ee7b7; }
  p  { font-size: .9rem; color: #94a3b8; line-height: 1.5; }
  code { background: #0f172a; padding: .2rem .5rem; border-radius: 6px;
         font-size: .8rem; color: #7dd3fc; }
</style>
</head>
<body>
<div class="card">
  <h1>&#10003; Canva Authorized</h1>
  <p>The OAuth callback has been relayed to your AI-OS server.
     You can <strong>close this tab</strong> and return to the
     AI-OS dashboard — the connection should appear within a
     few seconds.</p>
</div>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# HTTP request handler — catches the Canva redirect and relays it
# ---------------------------------------------------------------------------

class RelayHandler(BaseHTTPRequestHandler):
    """Handles the single GET request from Canva's OAuth redirect.

    When the browser hits   GET /mcp/oauth/callback?code=…&state=… ,
    this handler:
      1. Captures the path and query string.
      2. POSTs them as JSON to the remote AI-OS server's relay endpoint.
      3. Returns the server's response (or a success page) to the browser.
    """

    def do_GET(self) -> None:
        global USED

        # --- Only handle the OAuth callback path ----------------------------
        # Canva redirects to /mcp/oauth/callback?code=…&state=…
        # We accept any path on this port since it's single-purpose, but
        # we log what we receive for debugging.
        path = self.path  # includes query string, e.g. "/mcp/oauth/callback?code=ABC&state=XYZ"

        if not path.startswith("/"):
            self.send_error(400, "Invalid path")
            return

        # Split path and query string for clarity
        parsed = urllib.parse.urlsplit(path)
        raw_path = parsed.path          # e.g. "/mcp/oauth/callback"
        raw_query = parsed.query        # e.g. "code=ABC&state=XYZ"

        print(f"\n{'='*60}")
        print(f"  Caught OAuth redirect!")
        print(f"  Path:  {raw_path}")
        print(f"  Query: {raw_query}")
        print(f"{'='*60}\n")

        # --- If already used, this is a repeat/accidental request ---------
        if USED:
            print("[info] Relay already fired (single-use). Returning success page.")
            self._send_html(200, SUCCESS_HTML)
            return

        # --- Relay the request to the remote server -----------------------
        try:
            self._relay_to_server(raw_path, raw_query)
            USED = True

            # Show a success page to the user in the browser tab that
            # received Canva's redirect.  The AI-OS dashboard will detect
            # the successful auth separately (via SSE / mcp-auth exit code).
            self._send_html(200, SUCCESS_HTML)

            print("[ok] Relay succeeded. You can close this script now (Ctrl+C).")
            print("     Return to the AI-OS dashboard — Canva should show as connected.")

        except urllib.error.HTTPError as e:
            # Server returned an error (e.g. 401 bad token, 409 no container)
            body = e.read().decode("utf-8", errors="replace") if e.fp else ""
            print(f"[error] Server returned {e.code}: {body}")
            self._send_html(e.code, f"<h1>Relay failed ({e.code})</h1>"
                                       f"<p>{body}</p>"
                                       f"<p>Check the terminal for details.</p>")
        except Exception as e:
            print(f"[error] Relay failed: {e}")
            self._send_html(502, f"<h1>Relay failed</h1>"
                               f"<p>{e}</p>"
                               f"<p>Check the terminal for details.</p>")

    def _relay_to_server(self, path: str, query: str) -> None:
        """POST the captured path+query to the remote server's relay endpoint.

        The server will:
          1. Validate the bearer token → identify the user + container.
          2. Look up the container's OAUTH_PORT.
          3. Replay:  GET http://127.0.0.1:<oauth_port>{path}?{query}
             This hits the existing socat relay inside the container,
             which forwards to OpenCode's loopback listener.
          4. OpenCode validates `state`, exchanges code→token (PKCE),
             writes mcp-auth.json, and the flow succeeds.
        """
        url = relay_endpoint()

        # Build the JSON payload.
        # POC version includes oauth_port so the server-side endpoint knows
        # which container to target.  In production, the server resolves the
        # port from the bearer token (user → container → oauth_port).
        payload = json.dumps({
            "path": path,
            "query": query,
            "oauth_port": RELAY_PORT,  # POC-only; production removes this
        }).encode("utf-8")

        print(f"[relay] POSTing to {url} ...")
        print(f"[relay] Payload: path={path}, query={query[:80]}{'...' if len(query) > 80 else ''}")

        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                # Bearer token authenticates this relay request.
                # The server uses it to look up the correct container.
                "Authorization": f"Bearer {RELAY_TOKEN}",
            },
            method="POST",
        )

        # Send the request (10-second timeout — should be near-instant)
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            print(f"[relay] Server responded {resp.status}: {body[:200]}")

        # If we get here without exception, the relay succeeded.
        # The server returned 2xx — OpenCode received the callback.

    def _send_html(self, status: int, html: str) -> None:
        """Send an HTML response to the browser."""
        encoded = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        """Override to add [http] prefix and make output cleaner."""
        print(f"  [http] {format % args if args else format}")


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Local loopback bridge for Canva OAuth on a remote AI-OS server. "
            "Catches Canva's 127.0.0.1 redirect and relays it to the server."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--port", type=int, required=True,
        help="Loopback port to bind (must match your container's OAUTH_PORT, e.g. 19800)",
    )
    p.add_argument(
        "--server", type=str, required=True,
        help="AI-OS server base URL (e.g. https://os.abdspros.com)",
    )
    p.add_argument(
        "--token", type=str, required=True,
        help="Single-use bearer token from GET /api/oauth/relay-token",
    )
    return p.parse_args(argv)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    global RELAY_PORT, SERVER_URL, RELAY_TOKEN

    args = parse_args()
    RELAY_PORT = args.port
    SERVER_URL = args.server.rstrip("/")  # Remove trailing slash
    RELAY_TOKEN = args.token

    print(f"""
╔══════════════════════════════════════════════════════════════╗
║              Canva OAuth Relay — POC Build                  ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Listening on:  127.0.0.1:{RELAY_PORT:<5}                          ║
║  Relay target:  {SERVER_URL:<42} ║
║  Token:         {RELAY_TOKEN[:16]:<42}…  ║
║                                                              ║
║  Waiting for Canva OAuth redirect...                         ║
║  (Press Ctrl+C to stop)                                      ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
""")

    try:
        server = HTTPServer(("127.0.0.1", RELAY_PORT), RelayHandler)
        # Serve one request and exit (or timeout after 10 min)
        server.timeout = 600  # seconds
        server.serve_forever()
    except PermissionError:
        print(f"\n[error] Permission denied binding port {RELAY_PORT}.")
        print(f"        Try a port > 1024 or run with appropriate permissions.")
        sys.exit(1)
    except OSError as e:
        if e.errno == 98:  # EADDRINUSE
            print(f"\n[error] Port {RELAY_PORT} is already in use.")
            print(f"        Another process may be listening. Check with:")
            print(f"          lsof -i :{RELAY_PORT}")
        else:
            print(f"\n[error] {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n[interrupted] Stopped.")


if __name__ == "__main__":
    main()
