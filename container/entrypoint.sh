#!/usr/bin/env bash
# Per-user privilege drop. Same image, N users — the orchestrator sets
# APP_UID/APP_GID (or accepts the default 2000:2000) and mounts a workspace
# volume; this script materializes a matching OS user, fixes ownership of the
# mounted volume, then execs the user command as that user.
#
# Designed to be idempotent across container restarts.
set -euo pipefail

APP_UID="${APP_UID:-2000}"
APP_GID="${APP_GID:-2000}"
APP_USER="appuser"
APP_GROUP="appuser"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
APP_DIR="${APP_DIR:-/app}"

echo "[entrypoint] provisioning user ${APP_USER} uid=${APP_UID} gid=${APP_GID}"

# Group: create with requested GID, or reuse an existing one occupying it.
if ! getent group "${APP_GROUP}" >/dev/null; then
  if getent group "${APP_GID}" >/dev/null; then
    APP_GROUP="$(getent group "${APP_GID}" | cut -d: -f1)"
    echo "[entrypoint] gid ${APP_GID} already in use as group '${APP_GROUP}'; reusing"
  else
    groupadd --gid "${APP_GID}" "${APP_GROUP}"
  fi
fi

# User: create with requested UID, or reuse an existing one occupying it.
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  if getent passwd "${APP_UID}" >/dev/null; then
    APP_USER="$(getent passwd "${APP_UID}" | cut -d: -f1)"
    echo "[entrypoint] uid ${APP_UID} already in use as user '${APP_USER}'; reusing"
  else
    useradd \
      --uid "${APP_UID}" \
      --gid "${APP_GID}" \
      --home-dir "${WORKSPACE_DIR}" \
      --shell /bin/bash \
      "${APP_USER}"
  fi
fi

# Seed the workspace with image defaults if the mounted volume is empty.
# Lets a fresh user `opencode` straight into a working config + skills without
# a separate init step. Existing files are never overwritten.
shopt -s dotglob nullglob
if [ -z "$(ls -A "${WORKSPACE_DIR}" 2>/dev/null || true)" ]; then
  echo "[entrypoint] initializing empty workspace at ${WORKSPACE_DIR}"
  cp -f -R "${APP_DIR}/opencode.jsonc" "${WORKSPACE_DIR}/" 2>/dev/null || true
  # AGENTS.md is the agent's permanent environment context (where /workspace is,
  # how instances + state.json + memory.md work). Always copy so the agent knows
  # its operating environment from the first session.
  cp -f -R "${APP_DIR}/AGENTS.md" "${WORKSPACE_DIR}/" 2>/dev/null || true
  [ -d "${APP_DIR}/skills" ]   && cp -n -R "${APP_DIR}/skills"   "${WORKSPACE_DIR}/" 2>/dev/null || true
  [ -d "${APP_DIR}/fixtures" ] && cp -n -R "${APP_DIR}/fixtures" "${WORKSPACE_DIR}/" 2>/dev/null || true
fi

# Fix ownership of the mounted volume so the non-root user can write to it.
# Deliberately scoped to the workspace — never chown the image's /app.
chown -R "${APP_UID}:${APP_GID}" "${WORKSPACE_DIR}"

# Drop privileges and hand off to the CMD (default: `opencode`).
echo "[entrypoint] exec as ${APP_USER}: $*"
exec gosu "${APP_UID}:${APP_GID}" "$@"
