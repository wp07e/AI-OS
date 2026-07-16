#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# onstart-baked.sh — minimal boot script for the pre-built GPU image.
#
# This replaces the full onstart.sh when using a baked Docker image
# (walkerp07/blender-mcp:latest). Everything except service launches is already
# in the image. This script only:
#   1. Injects the SSH public key (per-lease, can't be baked)
#   2. Launches Xvfb + Blender with the addon socket server
#   3. Waits for the socket and writes the readiness sentinel
#
# Takes ~5 seconds instead of 5-7 minutes.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

LOG=/root/onstart.log
BLENDER_PORT="${BLENDER_PORT:-9876}"
SENTINEL=/root/.blender-mcp-ready
BLENDER_BIN="/opt/blender/blender"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG" >&2; }

log "=== blender GPU onstart (baked image) beginning ==="

# ── 1. Inject the SSH public key (passed via --env GPU_SSH_PUBKEY) ──────────
if [ -n "${GPU_SSH_PUBKEY:-}" ]; then
  mkdir -p /root/.ssh
  echo "$GPU_SSH_PUBKEY" >> /root/.ssh/authorized_keys
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/authorized_keys
  log "injected SSH public key from GPU_SSH_PUBKEY env var"
else
  log "WARNING: GPU_SSH_PUBKEY not set — SSH key injection skipped"
fi

# ── 2. Launch Xvfb (virtual display) ────────────────────────────────────────
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  log "starting Xvfb on display :99..."
  Xvfb :99 -screen 0 1280x720x24 >/root/xvfb.log 2>&1 &
  sleep 1
else
  log "Xvfb already running"
fi
export DISPLAY=:99

# ── 3. Launch Blender with the addon + socket server ────────────────────────
pkill -f "blender" 2>/dev/null || true
sleep 1
mkdir -p /root/blender/renders

log "launching Blender (GUI under Xvfb) with blender-mcp on port ${BLENDER_PORT}..."
DISPLAY=:99 BLENDER_PORT=${BLENDER_PORT} "$BLENDER_BIN" --python /root/start_blender_mcp.py >>"$LOG" 2>&1 &

# ── 4. Wait for the socket, then write the sentinel ────────────────────────
log "waiting for blender-mcp socket on 127.0.0.1:${BLENDER_PORT}..."
for i in $(seq 1 60); do
  if (exec 3<>/dev/tcp/127.0.0.1/${BLENDER_PORT}) 2>/dev/null; then
    exec 3>&- 3<&-
    log "blender-mcp socket is listening after $((i*1))s"
    date -u +%Y-%m-%dT%H:%M:%SZ >"$SENTINEL"
    log "=== blender GPU onstart complete (sentinel written) ==="
    exit 0
  fi
  sleep 1
done

log "FATAL: blender-mcp socket did not come up within 60 seconds"
log "--- last 30 lines of blender output ---"
tail -30 "$LOG" >&2 || true
exit 1
