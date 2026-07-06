# AI OS — Web Frontend

Next.js 15 (App Router) frontend + orchestration backend for AI OS. Authenticates
users, launches an isolated per-user Docker container running `opencode serve`,
walks the user through the Canva OAuth flow, and exposes a chat-style tool that
proxies messages to the user's container.

## Architecture

```
Browser ── Next.js (this app, port 3000)
              │
              ├── SQLite (data/aios.db): users, sessions, per-user container/port records
              ├── docker compose -p aios-<user> -f compose/user.compose.yml up -d
              │       │
              │       └── per-user ai-os container
              │             ├── opencode serve on 0.0.0.0:4096  → host <OPENCODE_PORT>
              │             └── socat relay on <RELAY_PORT>      → host <OAUTH_PORT>
              │
              └── Proxies chat to 127.0.0.1:<OPENCODE_PORT>
```

The base image (`ai-os-base:latest`), the LiteLLM singleton, and the shared
`ai-os_ai-os-net` network all live in [`../container/`](../container/). This app
**reuses** that network and image; it does not redefine them.

### Per-user port allocation

Each user gets two host ports from pools:

- `OPENCODE_PORT` from `4100–4199` — `opencode serve` HTTP. Proxied by the backend.
- `OAUTH_PORT` / `RELAY_PORT` from `19800–19899` — Canva OAuth relay.

The OAuth relay chain per user:

```
browser → 127.0.0.1:<OAUTH_PORT>      (host published port)
        → container:<RELAY_PORT>       (compose mapping)
        → socat → 127.0.0.1:<OAUTH_PORT>  (OpenCode loopback listener)
```

Because the host-published port equals OpenCode's internal loopback port, the
`redirect_uri` OpenCode generates resolves naturally through the mapping, and
multiple users can OAuth concurrently. The `mcp-auth` script in the base image
reads `MCP_AUTH_OAUTH_PORT` and `MCP_AUTH_RELAY_PORT` env vars (defaults
`19876`/`19877`).

## Prerequisites

1. **Docker** running and reachable from your user.
2. The base image built and the LiteLLM singleton up:

   ```sh
   cd ../container
   cp .env.example .env        # then edit .env with real keys
   docker compose build ai-os   # builds ai-os-base:latest
   docker compose up -d litellm # creates the ai-os_ai-os-net network + LiteLLM
   ```

   (The parametric `mcp-auth` change in `Dockerfile` requires a one-time rebuild.)

## Setup

```sh
npm install
npm run seed        # literal:creates the default user from SEED_USERNAME / SEED_PASSWORD env vars
npm run dev         # http://localhost:3000
```

literal:Default login: set SEED_USERNAME and SEED_PASSWORD in web/.env.local.

## Flow

1. `/login` → cookie-based session (signed HMAC token, stored in SQLite).
2. `/launching` → backend allocates ports, runs
   `docker compose -p aios-<user> -f compose/user.compose.yml up -d`, polls the
   opencode port until it accepts connections, then redirects.
3. `/oauth` → user clicks **OK**; backend execs
   `docker compose exec ai-os mcp-auth Canva`, streams the authorize URL to the
   page (SSE). User opens it in their browser; on success the token is cached in
   the user's workspace volume.
4. `/app` → header with profile dropdown (Settings stub, Sign out). Main tool is
   a textbox; **Enter** sends `POST /api/tools/message`, which the backend
   proxies to the user's opencode container.

## Notes / MVP simplifications

- The chat tool uses opencode's documented HTTP API
  ([opencode.ai/docs/server](https://opencode.ai/docs/server/)):
  `POST /session` to start a conversation (cached per user in
  `opencode_sessions`), then `POST /session/:id/message` with
  `{ parts: [{ type: "text", text }] }`. Assistant text parts are concatenated
  and rendered as a chat bubble. A "Show raw parts" toggle in the header exposes
  the full response for debugging.
- Container readiness uses `GET /global/health` (`{ healthy, version }`) with a
  120s timeout, replacing the earlier TCP-only probe.
- If the cached opencode session is rejected (404 — e.g. after a container
  restart), `/api/tools/message` automatically invalidates and retries once.
- OAuth success is inferred from `mcp-auth`'s exit code (token cached in the
  workspace volume). No live Canva auth-check yet.
- Single Next.js process; port pools assume single-host deployment.
- Avatars are generated via DiceBear initials (no upload).

### Optional: opencode server auth

If you set `OPENCODE_SERVER_PASSWORD` in the ai-os container's environment, the
opencode HTTP API requires HTTP Basic auth (`opencode:<password>`). The backend
reads the same env var and adds the Authorization header automatically — no
frontend change required.
