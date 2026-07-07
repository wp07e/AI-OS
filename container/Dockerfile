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

# uv — Python package runner used to launch the Grok MCP. The installer ships
# a static binary; we drop it into /usr/local/bin so the non-root appuser gets
# it on PATH. uv fetches its own managed CPython; we point the install dir at
# a system-wide, world-readable path so the baked interpreter is reusable by
# every user without re-downloading.
ADD https://astral.sh/uv/install.sh /tmp/uv-installer.sh
RUN sh /tmp/uv-installer.sh \
 && cp /root/.local/bin/uv  /usr/local/bin/uv \
 && cp /root/.local/bin/uvx /usr/local/bin/uvx 2>/dev/null || true \
 && rm -rf /root/.local /tmp/uv-installer.sh
ENV UV_LINK_MODE=copy \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    PYTHONUNBUFFERED=1

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
COPY AGENTS.md      ${APP_DIR}/AGENTS.md
COPY skills/        ${APP_DIR}/skills/
COPY fixtures/      ${APP_DIR}/fixtures/

# ─── Grok MCP ──────────────────────────────────────────────────────────────
# Bundled Python MCP server (xAI Grok). Source lives in the image at
# /app/mcps/grok-mcp. The venv is pre-synced here, in the runtime stage, so
# the recorded interpreter matches the image uv will use at first launch
# (uv-created venvs are not portable across base images). uv fetches its own
# managed CPython during this sync; subsequent per-user launches reuse the
# baked venv and never touch the network for deps.
ENV GROK_MCP_DIR=${APP_DIR}/mcps/grok-mcp
COPY mcps/grok-mcp/pyproject.toml mcps/grok-mcp/uv.lock ${GROK_MCP_DIR}/
COPY mcps/grok-mcp/main.py ${GROK_MCP_DIR}/
COPY mcps/grok-mcp/src/ ${GROK_MCP_DIR}/src/
RUN --mount=type=cache,target=/root/.cache/uv \
    cd ${GROK_MCP_DIR} \
 && uv sync --frozen --no-dev \
 && find ${GROK_MCP_DIR}/.venv -type d -name __pycache__ -prune -exec rm -rf {} + \
 && chmod -R a+rX /opt/uv/python
# Tell uv not to re-sync the baked venv at runtime — keeps it usable by the
# non-root appuser without write access. NOTE: we deliberately do NOT set
# UV_PROJECT_ENVIRONMENT globally: it would pin every `uv run` to one
# project's venv. Without it, uv uses each project's own .venv (the default),
# which is what we want for every bundled MCP.
ENV UV_FROZEN=1

# ─── Layerre MCP ───────────────────────────────────────────────────────────
# Bundled Python MCP server for the Layerre API (Canva → template → variant
# rendering). Same bake pattern as Grok: venv synced in the runtime stage so
# the recorded interpreter matches the image uv will use at first launch.
# Because UV_PROJECT_ENVIRONMENT is not set globally, uv creates this venv in
# /app/mcps/layerre-mcp/.venv (its default) rather than clobbering grok's.
ENV LAYERRE_MCP_DIR=${APP_DIR}/mcps/layerre-mcp
COPY mcps/layerre-mcp/pyproject.toml mcps/layerre-mcp/uv.lock ${LAYERRE_MCP_DIR}/
COPY mcps/layerre-mcp/main.py ${LAYERRE_MCP_DIR}/
COPY mcps/layerre-mcp/src/ ${LAYERRE_MCP_DIR}/src/
RUN --mount=type=cache,target=/root/.cache/uv \
    cd ${LAYERRE_MCP_DIR} \
 && uv sync --frozen --no-dev \
 && find ${LAYERRE_MCP_DIR}/.venv -type d -name __pycache__ -prune -exec rm -rf {} +

#------------------------------------------
# TODO: Workaround for OpenCode OAuth.
# OpenCode binds its OAuth callback to 127.0.0.1:<OAUTH_PORT> regardless of the
# redirect_uri host. This script bridges the loopback listener out to a
# container-wide 0.0.0.0:<RELAY_PORT> so the host browser can reach the
# callback via a published port mapping.
#
# Ports are configurable per user so multiple users can OAuth concurrently:
#   MCP_AUTH_OAUTH_PORT  OpenCode loopback listen + redirect_uri port (def 19876)
#   MCP_AUTH_RELAY_PORT  in-container socat listen port, mapped to host       (def 19877)
#
# Chain: browser -> 127.0.0.1:<OAUTH_PORT> (host) -> container:<RELAY_PORT>
#         -> socat -> 127.0.0.1:<OAUTH_PORT> (OpenCode)
# The trick: host-published port == OpenCode's internal port, so the redirect_uri
# OpenCode generates naturally resolves back through the mapping.
#
# Remove once OpenCode supports a configurable OAuth callback host.
COPY <<'EOF' /usr/local/bin/mcp-auth
#!/bin/bash
set -euo pipefail

OAUTH_PORT="${MCP_AUTH_OAUTH_PORT:-19876}"
RELAY_PORT="${MCP_AUTH_RELAY_PORT:-19877}"

echo "[mcp-auth] Starting OpenCode OAuth flow (oauth=${OAUTH_PORT}, relay=${RELAY_PORT})..."

# Start OpenCode OAuth in the background. Binds 127.0.0.1:${OAUTH_PORT}.
opencode mcp auth "$@" &
OPENCODE_PID=$!

echo "[mcp-auth] Waiting for OpenCode to bind to 127.0.0.1:${OAUTH_PORT}..."

# Wait for OpenCode to start listening.
for i in {1..50}; do
    if ss -ltn 2>/dev/null | grep -q "127.0.0.1:${OAUTH_PORT}"; then
        echo "[mcp-auth] OpenCode listener detected."
        break
    fi
    sleep 0.2
done

echo "[mcp-auth] Starting relay 0.0.0.0:${RELAY_PORT} -> 127.0.0.1:${OAUTH_PORT}"

socat \
    TCP-LISTEN:${RELAY_PORT},fork,bind=0.0.0.0,reuseaddr \
    TCP:127.0.0.1:${OAUTH_PORT} &
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

# Default OAuth callback port for opencode's MCP auth flow. Per-user containers
# override this (and MCP_AUTH_RELAY_PORT) so multiple users can OAuth concurrently.
# MUST be set so {env:MCP_AUTH_OAUTH_PORT} in opencode.jsonc interpolates to a
# valid URI even when no override is provided.
ENV MCP_AUTH_OAUTH_PORT=19876
ENV MCP_AUTH_RELAY_PORT=19877

# OpenCode writes here. Mounted as a volume per user so state (auth tokens,
# session history, generated designs) persists across container restarts and
# stays isolated between users.
VOLUME [ "${WORKSPACE_DIR}" ]

# Tini reaps zombies and forwards signals; entrypoint.sh drops privileges
# before handing control to whatever CMD the orchestrator passes (default: an
# interactive opencode shell).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
CMD ["opencode", "serve"]