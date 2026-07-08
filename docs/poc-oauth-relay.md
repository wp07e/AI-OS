# POC: Remote Canva OAuth Relay

**Status:** Active POC — validates the relay architecture before full production build.
**Date:** 2026-07-08

## What we're proving

That a Python script running on a user's laptop can catch Canva's `127.0.0.1` OAuth redirect and relay it to the remote server, which replays it into the correct container's OpenCode — completing the OAuth flow identically to how it works locally.

## Server details

| Item | Value |
|---|---|
| Server | `os.abdspros.com` |
| Next.js port | 3000 (behind nginx) |
| Container name | `literal:aios-<username>-ai-os-1` |
| OPENCODE_PORT | 4100 |
| OAUTH_PORT (host) | 19800 |
| RELAY_PORT (host→container) | 19801 |
| nginx | Terminates TLS, proxies `/*` → `127.0.0.1:3000` |

## The relay chain

```
User's laptop (127.0.0.1:19800)           Remote server
─────────────────────────────           ──────────────
Python helper catches GET                    │
/mcp/oauth/callback?code=…&state=…          │
          │                                  │
          │  HTTPS POST                      │
          │  /api/oauth/relay-poc            │
          │  {path, query, oauth_port}        │
          ├─────────────────────────────────→│
                                            │  fetch GET
                                            │  http://127.0.0.1:19800
                                            │  /mcp/oauth/callback?…
                                            │       │
                                            │       ▼
                                            │  Docker port 19800
                                            │  → container:19801 (socat)
                                            │  → 127.0.0.1:19800 (OpenCode)
                                            │  → validates state, exchanges code→token
                                            │  → writes mcp-auth.json
                                            │  ← 200 response
                                            │
          │  ← 200 (OpenCode's response) ───┘
          ▼
Browser shows "✓ Canva Authorized"
```

## POC steps

### Step 0: Deploy the POC route

The `relay-poc` route is already committed at:
```
web/src/app/api/oauth/relay-poc/route.ts
```

Build and deploy the Next.js app on the server so the route is live at:
```
https://os.abdspros.com/api/oauth/relay-poc
```

### Step 1: Start the OAuth flow in the AI-OS web UI

1. Log in to `https://os.abdspros.com`.
2. Navigate to the Canva OAuth page (the "Authorize Canva" flow).
3. Click **OK** to start the flow.
4. The web UI will show the authorize URL from Canva (something like
   `https://mcp.canva.com/authorize?…&redirect_uri=http%3A%2F%2F127.0.0.1%3A19800%2F…`).
5. **Do NOT click "Open in Browser" yet** — that would redirect Canva to the server's
   loopback (which the user's browser can't reach).

### Step 2: Start the Python helper on your laptop

Run the helper script (it's in the repo at `scripts/canva-oauth-relay.py`):

```bash
python3 scripts/canva-oauth-relay.py \
    --port 19800 \
    --server https://os.abdspros.com \
    --token poc-test-token
```

You should see:
```
╔══════════════════════════════════════════════════════════════╗
║              Canva OAuth Relay — POC Build                  ║
╠══════════════════════════════════════════════════════════════╣
║  Listening on:  127.0.0.1:19800                             ║
║  Waiting for Canva OAuth redirect...                         ║
╚══════════════════════════════════════════════════════════════╝
```

> **Note:** The POC uses a hardcoded token (`poc-test-token`). The production
> version will mint real single-use bearer tokens. The POC route accepts any
> request regardless of token — this is intentional for testing only.

### Step 3: Open the authorize URL in your browser

Now click **"Open in Browser"** in the AI-OS web UI (or paste the authorize URL
directly). Canva will show its consent screen.

**Important:** Approve access on Canva.  Canva will then redirect your browser to:
```
http://127.0.0.1:19800/mcp/oauth/callback?code=…&state=…
```

Because the Python helper is now listening on `127.0.0.1:19800` on your laptop,
it catches this redirect instead of the browser failing.

### Checkpoints

#### Checkpoint A: Helper catches the redirect

In the terminal running the Python helper, you should see:
```
============================================================
  Caught OAuth redirect!
  Path:  /mcp/oauth/callback
  Query: code=…&state=…
============================================================

[relay] POSTing to https://os.abdspros.com/api/oauth/relay-poc ...
[relay] Payload: path=/mcp/oauth/callback, query=code=…
```

On the server, check Next.js logs (`docker logs` or `journalctl`):
```
[relay-poc] Replaying to: http://127.0.0.1:19800/mcp/oauth/callback?code=…&state=…
```

If you see both of these, **Checkpoint A passes** — the helper→server relay works.

#### Checkpoint B: OpenCode completes the exchange

In the Python helper terminal, you should then see:
```
[relay] Server responded 200: …
[ok] Relay succeeded. You can close this script now (Ctrl+C).
     Return to the AI-OS dashboard — Canva should show as connected.
```

On the server, verify the token was written:
```bash
docker exec literal:aios-<username>-ai-os-1 cat /workspace/.local/share/opencode/mcp-auth.json
```

This should return a JSON object with `Canva.tokens.accessToken` and
`Canva.tokens.expiresAt`.

Then check Canva's connection status via OpenCode's MCP endpoint:
```bash
curl -s http://127.0.0.1:4100/mcp | python3 -m json.tool
```

Look for `"Canva": { "status": "connected" }` (or similar — the exact
structure depends on OpenCode's response format).

If the token file exists and Canva shows connected, **Checkpoint B passes** —
the full relay chain works end-to-end.

### Step 4: Restart the container (if needed)

The AI-OS web UI should automatically detect the success (via SSE from the
`mcp-auth` process exit code) and trigger a container restart. If it doesn't,
restart manually:
```bash
docker restart literal:aios-<username>-ai-os-1
```

After restart, the AI-OS agent should be able to use Canva MCP tools.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Helper says "Port already in use" | Something else on 19800 | `lsof -i :19800` to find it |
| Canva shows an error after approval | Redirect URI mismatch | Verify `--port 19800` matches the OAUTH_PORT in the authorize URL |
| Server returns 502 | Can't reach container's socat relay | Check container is running: `docker ps` |
| Server returns connection refused | Next.js not running or route not deployed | Check `curl http://127.0.0.1:3000/api/oauth/relay-poc` on the server |
| Helper catches redirect but server shows nothing | HTTPS issue (the script posts over HTTPS) | Verify the server's cert is valid; try `curl -v https://os.abdspros.com/api/oauth/relay-poc` |
| Token file doesn't appear | OpenCode didn't complete the exchange | Check `docker logs literal:aios-<username>-ai-os-1` for opencode errors |

## POC cleanup (after validation)

Once both checkpoints pass, delete the POC route:
```bash
rm web/src/app/api/oauth/relay-poc/route.ts
```

Then proceed to Milestone 2: the production version with auth.
