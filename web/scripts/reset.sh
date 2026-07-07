#!/usr/bin/env bash
#
# reset.sh — wipe all per-user state so the next login is a true first-time
# experience, while preserving the shared prerequisites (LiteLLM singleton +
# ai-os_ai-os-net network) and literal:the seeded user.
#
# Usage:  ./scripts/reset.sh
#
# What gets removed:
#   - Every running or stopped aios-* container (the per-user containers)
#   - Every aios-* docker volume (per-user workspaces)
#   - All rows in sessions, containers, opencode_sessions, workflow_instances
#     (login state, port allocations, cached opencode sessions, workflow lanes)
#   - Any next dev / next-server process holding port 3000
#
# What is PRESERVED:
#   - ai-os-litellm container + ai-os_ai-os-net network (the launch
#     prerequisite — without these, launchForUser throws "network not found")
#   - literal:the seeded user row (so you can log straight back in)
#   - the ai-os-base:latest image
#   - the container_ai-os-workspace volume (belongs to the container/ dev harness)
#
# Safe to run repeatedly. Exits non-zero if any required step fails.

set -euo pipefail

# Resolve repo paths regardless of CWD. This script lives in web/scripts/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PATH="$WEB_DIR/data/aios.db"

log()  { printf '\033[1;36m[reset]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[reset]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[reset] error:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$DB_PATH" ]] || die "DB not found at $DB_PATH — run from the repo or check the path."
command -v docker  >/dev/null || die "docker not found in PATH."
command -v sqlite3 >/dev/null || die "sqlite3 not found in PATH."

# ─── 1. Stop the dev server ────────────────────────────────────────────────
log "stopping any next dev / next-server processes"
pkill -f "next dev"      2>/dev/null && log "  killed next dev"      || log "  (no next dev running)"
pkill -f "next-server"   2>/dev/null && log "  killed next-server"   || log "  (no next-server running)"
sleep 1
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  warn "port 3000 still held after pkill — force clearing:"
  lsof -nP -iTCP:3000 -sTCP:LISTEN -t 2>/dev/null | xargs kill -9 2>/dev/null || true
fi
log "port 3000 free"

# ─── 2. Remove all per-user containers ─────────────────────────────────────
# Important: pattern is anchored at ^aios- so we never touch ai-os-litellm
# (shared prerequisite) or ai-os-user-1 (the container/ dev harness).
log "removing per-user containers (aios-*)"
USER_CONTAINERS="$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^aios-' || true)"
if [[ -n "$USER_CONTAINERS" ]]; then
  echo "$USER_CONTAINERS" | while read -r name; do
    docker rm -f "$name" >/dev/null && log "  removed $name"
  done
else
  log "  (none)"
fi

# ─── 3. Remove all per-user volumes ────────────────────────────────────────
log "removing per-user volumes (aios-*)"
USER_VOLUMES="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '^aios-' || true)"
if [[ -n "$USER_VOLUMES" ]]; then
  echo "$USER_VOLUMES" | while read -r vol; do
    if docker volume rm "$vol" >/dev/null 2>&1; then
      log "  removed $vol"
    else
      warn "  could not remove $vol (still in use?)"
    fi
  done
else
  log "  (none)"
fi

# ─── 4. literal:Wipe DB rows (keep schema + the seeded user) ──────────────────────
log "clearing sessions / containers / opencode_sessions / workflow_instances rows in DB"
sqlite3 "$DB_PATH" \
  "DELETE FROM opencode_sessions;
   DELETE FROM workflow_instances;
   DELETE FROM containers;
   DELETE FROM sessions;"

# ─── 5. Verify prerequisites are intact ───────────────────────────────────
log "verifying shared prerequisites (litellm + network)"
if ! docker ps --format '{{.Names}}' | grep -q '^ai-os-litellm$'; then
  warn "ai-os-litellm is not running — launching it now (required for launch to succeed)"
  (cd "$WEB_DIR/../container" && docker compose up -d litellm >/dev/null 2>&1) \
    && log "  ai-os-litellm started" \
    || die "failed to start ai-os-litellm. Run: cd ../container && docker compose up -d litellm"
else
  log "  ai-os-litellm: running"
fi

if ! docker network inspect ai-os_ai-os-net >/dev/null 2>&1; then
  warn "ai-os_ai-os-net network missing — recreating via container compose"
  (cd "$WEB_DIR/../container" && docker compose up -d litellm >/dev/null 2>&1) \
    || die "failed to create ai-os_ai-os-net. Run: cd ../container && docker compose up -d litellm"
  log "  ai-os_ai-os-net: created"
else
  log "  ai-os_ai-os-net: present"
fi

# ─── 6. Summary ────────────────────────────────────────────────────────────
log "DB row counts:"
sqlite3 "$DB_PATH" \
  "SELECT '  users:              ' || count(*) FROM users;
   SELECT '  sessions:           ' || count(*) FROM sessions;
   SELECT '  containers:         ' || count(*) FROM containers;
   SELECT '  opencode_sessions:  ' || count(*) FROM opencode_sessions;
   SELECT '  workflow_instances: ' || count(*) FROM workflow_instances;"

echo
printf '\033[1;32m[reset] done.\033[0m State is clean. To start fresh:\n'
printf '  cd %s && npm run dev\n' "$WEB_DIR"
printf '  then open http://localhost:3000 literal:and log in with your SEED_USERNAME / SEED_PASSWORD\n'
