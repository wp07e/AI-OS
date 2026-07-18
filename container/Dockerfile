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
# openssh-client: required for the Blender workflow's GPU SSH tunnel (the host
#   lease manager execs `ssh -NfL 9876:...` inside this container to reach the
#   blender-mcp socket on the remote GPU instance). See web/src/lib/gpu/.
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
      ffmpeg \
      openssh-client \
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
# Deterministic carousel pipeline (drives the Canva MCP directly over HTTPS,
# bypassing opencode for generation). The agent runs these scripts instead of
# calling Canva generation tools itself — eliminates model-to-model variance.
# run.py is invoked as: uv run python /app/carousel/run.py <instance_folder>
COPY carousel/      ${APP_DIR}/carousel/
# Deterministic video pipeline (image/video generation via the xAI SDK,
# continuity via ffmpeg, final assembly via ffmpeg concat). The agent writes
# request.json and invokes this script; it never calls generation tools or
# ffmpeg itself. run.py is invoked as:
#   uv run --project /app/video python /app/video/run.py <folder> --request request.json
# ffmpeg is required (installed above) for last-frame extraction and assembly.
ENV VIDEO_PIPELINE_DIR=${APP_DIR}/video
COPY video/pyproject.toml ${VIDEO_PIPELINE_DIR}/
COPY video/*.py           ${VIDEO_PIPELINE_DIR}/
RUN --mount=type=cache,target=/root/.cache/uv \
    cd ${VIDEO_PIPELINE_DIR} \
 && uv sync --no-dev \
 && find ${VIDEO_PIPELINE_DIR}/.venv -type d -name __pycache__ -prune -exec rm -rf {} +

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
# ─── Vision MCP ─────────────────────────────────────────────────────────────
# Free-tier vision MCP (OpenRouter Qwen2.5-VL via LiteLLM). Gives the text-only
# agent a free way to verify Blender renders (framing, blank output, detached
# parts). Same bake pattern as grok-mcp: venv synced in the runtime stage so
# the recorded interpreter matches what uv reuses at launch. No uv.lock yet
# (small dep set), so sync without --frozen.
ENV VISION_MCP_DIR=${APP_DIR}/mcps/vision-mcp
COPY mcps/vision-mcp/pyproject.toml ${VISION_MCP_DIR}/
COPY mcps/vision-mcp/main.py ${VISION_MCP_DIR}/
COPY mcps/vision-mcp/src/ ${VISION_MCP_DIR}/src/
RUN --mount=type=cache,target=/root/.cache/uv \
    cd ${VISION_MCP_DIR} \
 && uv sync --no-dev \
 && find ${VISION_MCP_DIR}/.venv -type d -name __pycache__ -prune -exec rm -rf {} +

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

# ─── Blender workflow GPU bootstrap ─────────────────────────────────────────
# The Blender workflow rents an ephemeral GPU instance on vast.ai per workflow
# session. Blender + the blender-mcp add-on run on the GPU instance; the
# OpenCode agent drives them via the blender-mcp MCP server (declared in
# opencode.jsonc) which dials 127.0.0.1:9876 — reached through an SSH tunnel
# the host starts inside this container. See container/gpu/README.md.
#
# Two artifacts are baked here so the host lease manager can provision GPU
# instances without network access at runtime:
#   1. /app/gpu/addon.py   — the pinned blender-mcp Blender add-on, scp'd onto
#                            each GPU instance by the onstart script.
#   2. /app/gpu/onstart.sh — the vast.ai --onstart bootstrap script.
#
# Versioning: the blender-mcp GitHub repo has NO version tags, so addon.py is
# fetched from the `main` branch HEAD at build time (auto-updates on each build,
# matching how OPENCODE_VERSION=latest works below). To pin for reproducibility,
# pass --build-arg BLENDER_MCP_REF=<commit-sha>. The PyPI package (the MCP
# server the agent talks to) is resolved to the latest release by default; pin
# with --build-arg BLENDER_MCP_VERSION=<x.y.z>. Keep the two roughly in sync.
ARG BLENDER_MCP_REF=main
ARG BLENDER_MCP_VERSION=latest
# The Blender version the GPU onstart script downloads (NOT apt — apt only has
# 3.0.1 on Ubuntu 22.04). Downloaded from blender.org at instance boot time.
# Set to "latest-4.5" to auto-resolve, or pin to a specific version like "4.5.11".
ARG BLENDER_VERSION=4.5.11
ENV GPU_DIR=${APP_DIR}/gpu
# Fetch the addon at the resolved ref. We expand `main` to a concrete SHA first
# so the RUN layer is cache-keyed on a stable ref; a moving `main` would bust
# the cache unpredictably. When BLENDER_MCP_REF is already a SHA, this is a
# no-op passthrough.
RUN mkdir -p ${GPU_DIR} \
 && REF="${BLENDER_MCP_REF}" \
 && if [ "$REF" = "main" ]; then \
      REF=$(curl -fsSL "https://api.github.com/repos/ahujasid/blender-mcp/commits/main" \
        | grep -m1 '"sha"' | sed 's/.*"sha": "\([^"]*\)".*/\1/'); \
    fi \
 && echo "blender-mcp addon ref: $REF" \
 && curl -fsSL "https://raw.githubusercontent.com/ahujasid/blender-mcp/${REF}/addon.py" \
      -o ${GPU_DIR}/addon.py
COPY gpu/onstart.sh ${GPU_DIR}/onstart.sh
COPY gpu/onstart-baked.sh ${GPU_DIR}/onstart-baked.sh
RUN chmod +x ${GPU_DIR}/onstart.sh ${GPU_DIR}/onstart-baked.sh
# Pre-warm the blender-mcp MCP tool so the agent's first tool call isn't slow.
# `uvx blender-mcp` resolves the package into the uv cache; the actual MCP
# server process is started by opencode on demand via the opencode.jsonc entry.
# BLENDER_MCP_VERSION=latest picks up the newest release automatically (matches
# the mcp-remote@latest / opencode-ai@latest convention used elsewhere).
RUN --mount=type=cache,target=/root/.cache/uv \
    if [ "${BLENDER_MCP_VERSION}" = "latest" ]; then \
      uvx blender-mcp --help >/dev/null 2>&1 || true; \
    else \
      uvx --from "blender-mcp==${BLENDER_MCP_VERSION}" blender-mcp --help >/dev/null 2>&1 || true; \
    fi
# Deterministic Blender helper pipeline (lease bootstrap, artifact sync, headless
# batch render). The agent's interactive scene work goes through the blender MCP
# tools directly; this script owns only the non-agent-safe ops. run.py is
# invoked as:
#   uv run --project /app/blender python /app/blender/run.py <folder> --request request.json
ENV BLENDER_PIPELINE_DIR=${APP_DIR}/blender
COPY blender/pyproject.toml ${BLENDER_PIPELINE_DIR}/
COPY blender/*.py           ${BLENDER_PIPELINE_DIR}/
# Pre-sync the venv at build time (same pattern as /app/video above) so
# `uv run --project /app/blender` at runtime finds an existing .venv and does
# NOT try to create one inside the read-only /app/blender. Without this, the
# render route fails with "failed to create directory /app/blender/.venv:
# Permission denied" and state.json hangs at "starting" forever.
RUN --mount=type=cache,target=/root/.cache/uv \
    cd ${BLENDER_PIPELINE_DIR} \
 && uv sync --no-dev \
 && find ${BLENDER_PIPELINE_DIR}/.venv -type d -name __pycache__ -prune -exec rm -rf {} +

# ─── Python on PATH ────────────────────────────────────────────────────────
# uv manages its own CPython under UV_PYTHON_INSTALL_DIR (/opt/uv/python).
# The syncs above trigger the download, but the interpreter isn't on PATH by
# default. Symlink the baked binary so `python` / `python3` / `pip` just work.
RUN UV_PY=$(find ${UV_PYTHON_INSTALL_DIR} -path '*/bin/python3' 2>/dev/null | sort -V | tail -1) \
 && ln -sf "$UV_PY" /usr/local/bin/python3 \
 && ln -sf /usr/local/bin/python3 /usr/local/bin/python

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