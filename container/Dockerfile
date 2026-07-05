# syntax=docker/dockerfile:1.7
# Base image for the AI OS — OpenCode + Canva MCP + skills.
# One container instance is spawned per user; isolation is handled at runtime
# by entrypoint.sh (parametric UID/GID) and per-user volume mounts.
#
# No secrets are baked into this image. Canva OAuth is completed per-user at
# first run; the LiteLLM virtual key is injected via env.

ARG NODE_VERSION=22

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — install OS deps + the OpenCode CLI into a clean layer
# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS deps

# tini: PID 1 / signal handling
# gosu: drop from root to the per-user UID at runtime
# git, ca-certificates, curl: OpenCode + MCP bring-your-own-tool expectations
# NOTE: socat needed for OAuth
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini \
      gosu \
      git \
      ca-certificates \
      curl \
      socat \
 && rm -rf /var/lib/apt/lists/*

# Pre-fetch the Canva MCP bridge so first-run per-user launches don't pay the
# download cost. mcp-remote is the official transport for https://mcp.canva.com/mcp.
RUN npm install -g mcp-remote@latest

# OpenCode CLI. Pinning the major lets the orchestrator bump explicitly.
ARG OPENCODE_VERSION=latest
RUN npm install -g opencode-ai@${OPENCODE_VERSION}


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — runtime image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-slim AS runtime

# Re-install the slim set of OS tools we need at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini \
      gosu \
      git \
      ca-certificates \
      curl \
      bash \
      socat \
      iproute2 \
 && rm -rf /var/lib/apt/lists/*

# Carry over the globally-installed npm packages (opencode-ai, mcp-remote)
# and the npm cache so `npx mcp-remote` is instant on first user launch.
COPY --from=deps /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=deps /usr/local/bin /usr/local/bin/

# Image-owned application directory. Read-only at runtime; the per-user
# workspace is a separate mount so the same image serves every user.
ENV APP_DIR=/app
ENV WORKSPACE_DIR=/workspace
WORKDIR ${APP_DIR}

# Bake the read-only artifacts.
COPY entrypoint.sh ${APP_DIR}/entrypoint.sh
COPY opencode.jsonc ${APP_DIR}/opencode.jsonc
COPY skills/        ${APP_DIR}/skills/
COPY fixtures/      ${APP_DIR}/fixtures/

#------------------------------------------
# TODO: Workaround for OpenCode OAuth.
# OpenCode binds OAuth callback to 127.0.0.1 only.
# Relay host:19876 -> container:19877 -> 127.0.0.1:19876
# Remove once OpenCode supports configurable callback host.
COPY <<'EOF' /usr/local/bin/mcp-auth
#!/bin/bash
set -euo pipefail

echo "[mcp-auth] Starting OpenCode OAuth flow..."

# Start OpenCode OAuth in the background
opencode mcp auth "$@" &
OPENCODE_PID=$!

echo "[mcp-auth] Waiting for OpenCode to bind to 127.0.0.1:19876..."

# Wait for OpenCode to start listening
for i in {1..50}; do
    if ss -ltn 2>/dev/null | grep -q '127.0.0.1:19876'; then
        echo "[mcp-auth] OpenCode listener detected."
        break
    fi
    sleep 0.2
done

echo "[mcp-auth] Starting relay 0.0.0.0:19877 -> 127.0.0.1:19876"

socat \
    TCP-LISTEN:19877,fork,bind=0.0.0.0,reuseaddr \
    TCP:127.0.0.1:19876 &
SOCAT_PID=$!

cleanup() {
    kill "$SOCAT_PID" 2>/dev/null || true
}
trap cleanup EXIT

wait "$OPENCODE_PID"
EOF

RUN chmod +x /usr/local/bin/mcp-auth
#------------------------------------------

RUN chmod +x ${APP_DIR}/entrypoint.sh \
 && mkdir -p ${WORKSPACE_DIR} \
 && chown -R root:root ${APP_DIR}

# Defaults for the parametric non-root user. Override at runtime per tenant.
ENV APP_UID=2000
ENV APP_GID=2000

# OpenCode writes here. Mounted as a volume per user so state (auth tokens,
# session history, generated designs) persists across container restarts and
# stays isolated between users.
VOLUME [ "${WORKSPACE_DIR}" ]

# Tini reaps zombies and forwards signals; entrypoint.sh drops privileges
# before handing control to whatever CMD the orchestrator passes (default: an
# interactive opencode shell).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["opencode"]