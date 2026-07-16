#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# End-to-end GPU provisioning test.
#
# This script exercises the EXACT same vast.ai CLI calls our lease manager uses,
# so we can debug the full flow without touching the web app. It:
#   1. Generates a fresh SSH keypair (simulating the container's key)
#   2. Registers the pubkey on vast.ai
#   3. Searches for an offer under cap
#   4. Creates an instance with --ssh + onstart
#   5. Waits for running
#   6. Attaches the SSH key to the instance
#   7. Polls until SSH actually works (with generous timeout)
#   8. Runs the onstart script and waits for the blender-mcp socket
#   9. Starts a tunnel and verifies blender-mcp responds
#  10. Destroys the instance (always, in a trap)
#
# Usage:
#   VAST_API_KEY=... ./scripts/test-gpu-provision.sh
#
# Set DEBUG=1 for verbose output.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

KEY="${VAST_API_KEY:?VAST_API_KEY must be set}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ONSTART="$PROJECT_DIR/container/gpu/onstart.sh"
ADDON="$PROJECT_DIR/container/gpu/addon.py"

# Temp files for this test run
TMPDIR=$(mktemp -d)
SSH_KEY="$TMPDIR/gpu_test_ed25519"
INSTANCE_ID=""
SSH_KEY_ID=""
CREATED_KEY=0

trap cleanup EXIT

cleanup() {
  echo ""
  echo "=== CLEANUP ==="
  if [ -n "$INSTANCE_ID" ]; then
    echo "Destroying instance $INSTANCE_ID..."
    vastai destroy instance "$INSTANCE_ID" -y 2>&1 || true
  fi
  if [ "$CREATED_KEY" -eq 1 ] && [ -n "$SSH_KEY_ID" ]; then
    echo "Deleting SSH key $SSH_KEY_ID..."
    vastai delete ssh-key "$SSH_KEY_ID" 2>&1 || true
  fi
  rm -rf "$TMPDIR"
}

log() { echo -e "\n[$(date -u +%H:%M:%S)] $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# ── 1. Generate SSH keypair ─────────────────────────────────────────────────
log "1. Generating test SSH keypair..."
ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -q
PUBKEY=$(cat "${SSH_KEY}.pub")
echo "   Public key: ${PUBKEY:0:60}..."

# ── 2. Register on vast.ai ──────────────────────────────────────────────────
log "2. Registering SSH key on vast.ai..."
RESULT=$(vastai create ssh-key "$PUBKEY" -y 2>&1) || fail "create ssh-key failed: $RESULT"
SSH_KEY_ID=$(echo "$RESULT" | grep -o "'id': [0-9]*" | grep -o "[0-9]*")
[ -n "$SSH_KEY_ID" ] || fail "could not parse ssh key id from: $RESULT"
CREATED_KEY=1
echo "   Key ID: $SSH_KEY_ID"

# ── 3. Search for an offer ──────────────────────────────────────────────────
log "3. Searching for GPU offers under \$0.09/hr..."
# Search each allowed GPU model separately (vastai doesn't support OR'd gpu_name)
BEST_OFFER=""
BEST_DPH=999
for GPU in "RTX_4060" "RTX_4060_Ti" "RTX_5060" "RTX_5060_Ti" "RTX_A4000"; do
  # Determine CUDA floor
  CUDA_FLOOR=12
  if [[ "$GPU" == "RTX_5060" || "$GPU" == "RTX_5060_Ti" ]]; then CUDA_FLOOR=12.8; fi
  QUERY="gpu_name=${GPU} dph_total<=0.09 cuda_max_good>=${CUDA_FLOOR} verified=true"
  if [ "${DEBUG:-0}" = "1" ]; then echo "   Query: $QUERY"; fi
  OFFERS=$(vastai search offers "$QUERY" -t on_demand --order 'dlperf_per_dphtotal-' --limit 1 --raw 2>/dev/null) || continue
  OFFER_ID=$(echo "$OFFERS" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d[0]['id'] if d else '')" 2>/dev/null) || continue
  OFFER_DPH=$(echo "$OFFERS" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(round(d[0]['dph_total'],4) if d else '')" 2>/dev/null) || continue
  OFFER_GPU=$(echo "$OFFERS" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d[0]['gpu_name'] if d else '')" 2>/dev/null) || continue
  if [ -n "$OFFER_ID" ] && [ -n "$OFFER_DPH" ]; then
    if (( $(echo "$OFFER_DPH < $BEST_DPH" | bc -l) )); then
      BEST_OFFER=$OFFER_ID
      BEST_DPH=$OFFER_DPH
      BEST_GPU=$OFFER_GPU
    fi
    echo "   $GPU: offer $OFFER_ID at \$$OFFER_DPH/hr"
  fi
done
[ -n "$BEST_OFFER" ] || fail "no qualifying offers found under cap"
echo "   Selected: offer $BEST_OFFER ($BEST_GPU at \$$BEST_DPH/hr)"

# ── 4. Create instance ──────────────────────────────────────────────────────
log "4. Creating instance from offer $BEST_OFFER..."

# Read the onstart script content (this is what --onstart-cmd receives)
if [ ! -f "$ONSTART" ]; then fail "onstart.sh not found at $ONSTART"; fi
ONSTART_CONTENT=$(cat "$ONSTART")

CREATE_RESULT=$(vastai create instance "$BEST_OFFER" \
  --image nvidia/cuda:12.4.1-runtime-ubuntu22.04 \
  --disk 50 \
  --ssh --direct \
  --onstart-cmd "$ONSTART_CONTENT" \
  --label "gpu-provision-test" \
  --env "-e GPU_SSH_PUBKEY=$PUBKEY" \
  --force 2>&1) || fail "create instance failed: $CREATE_RESULT"
INSTANCE_ID=$(echo "$CREATE_RESULT" | grep -o "'new_contract': [0-9]*" | grep -o "[0-9]*")
[ -n "$INSTANCE_ID" ] || INSTANCE_ID=$(echo "$CREATE_RESULT" | grep -oE "[0-9]{7,}" | head -1)
[ -n "$INSTANCE_ID" ] || fail "could not parse instance id from: $CREATE_RESULT"
echo "   Instance ID: $INSTANCE_ID"

# ── 5. Wait for running ─────────────────────────────────────────────────────
log "5. Waiting for instance to reach 'running' state..."
for i in $(seq 1 60); do
  STATE=$(vastai show instance "$INSTANCE_ID" --raw 2>/dev/null | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('cur_state','?'))" 2>/dev/null) || STATE="?"
  echo -ne "   [$i] cur_state=$STATE\r"
  if [ "$STATE" = "running" ]; then echo ""; break 2; fi
  if [ "$STATE" = "error" ]; then fail "instance entered error state"; fi
  sleep 5
done
[ "$STATE" = "running" ] || fail "instance did not reach running"
echo "   Instance is running."

# ── 6. Attach SSH key ───────────────────────────────────────────────────────
log "6. Attaching SSH key to instance..."
ATTACH_RESULT=$(vastai attach ssh "$INSTANCE_ID" "$PUBKEY" 2>&1) || true
echo "   Attach result: $ATTACH_RESULT"

# ── 7. Get SSH URL and poll until SSH works ─────────────────────────────────
log "7. Waiting for SSH to accept connections (generous timeout — image boot takes minutes)..."
SSH_URL=$(vastai ssh-url "$INSTANCE_ID" --raw 2>/dev/null)
SSH_HOST=$(echo "$SSH_URL" | sed 's|ssh://root@||;s|:.*||')
SSH_PORT=$(echo "$SSH_URL" | sed 's|.*:||')
echo "   SSH URL: $SSH_URL (host=$SSH_HOST port=$SSH_PORT)"

SSH_OK=0
for i in $(seq 1 72); do  # 72 * 10s = 12 min max
  SSH_OUTPUT=$(timeout 15 ssh -i "$SSH_KEY" -p "$SSH_PORT" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 -o BatchMode=yes \
    "root@$SSH_HOST" 'echo SSH_READY' 2>&1) || SSH_OUTPUT=""
  if echo "$SSH_OUTPUT" | grep -q "SSH_READY"; then
    SSH_OK=1
    echo "   SSH connected after $((i*10))s"
    break
  fi
  # Show what kind of failure we're seeing
  if [ $((i % 6)) -eq 0 ]; then
    ERR=$(echo "$SSH_OUTPUT" | tail -1)
    echo "   [$((i*10))s] still waiting... ($ERR)"
  fi
  sleep 10
done
[ "$SSH_OK" -eq 1 ] || fail "SSH never became ready after 12 minutes"

# ── 8. Wait for onstart to bring up blender-mcp ─────────────────────────────
log "8. Waiting for onstart to complete (checking sentinel + socket)..."
for i in $(seq 1 72); do  # 72 * 10s = 12 min max
  CHECK=$(timeout 15 ssh -i "$SSH_KEY" -p "$SSH_PORT" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 -o BatchMode=yes \
    "root@$SSH_HOST" 'test -f /root/.blender-mcp-ready && echo SENTINEL_OK; (echo > /dev/tcp/127.0.0.1/9876) 2>/dev/null && echo SOCKET_OK; tail -3 /root/onstart.log 2>/dev/null' 2>&1) || CHECK=""
  if echo "$CHECK" | grep -q "SENTINEL_OK"; then
    echo "   Sentinel found after $((i*10))s"
    break
  fi
  if [ $((i % 6)) -eq 0 ]; then
    LAST_LINE=$(echo "$CHECK" | grep -v "^$" | tail -1)
    echo "   [$((i*10))s] still waiting... ($LAST_LINE)"
  fi
  sleep 10
done
echo "$CHECK" | grep -q "SENTINEL_OK" || fail "onstart sentinel never appeared"

# ── 9. Verify the blender-mcp socket responds ───────────────────────────────
log "9. Testing blender-mcp socket..."
SOCKET_CHECK=$(timeout 15 ssh -i "$SSH_KEY" -p "$SSH_PORT" \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=10 -o BatchMode=yes \
  "root@$SSH_HOST" '(echo > /dev/tcp/127.0.0.1/9876) 2>/dev/null && echo SOCKET_OK || echo SOCKET_FAIL' 2>&1)
echo "$SOCKET_CHECK" | grep -q "SOCKET_OK" && echo "   Socket is listening!" || fail "Socket not listening"

# ── 10. Check what blender version + addon state ────────────────────────────
log "10. Checking Blender + addon state..."
FINAL_CHECK=$(timeout 15 ssh -i "$SSH_KEY" -p "$SSH_PORT" \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=10 -o BatchMode=yes \
  "root@$SSH_HOST" '/opt/blender/blender --version 2>/dev/null | head -1; ls /root/.config/blender/*/scripts/addons/blender_mcp/ 2>/dev/null; tail -20 /root/onstart.log' 2>&1)
echo "$FINAL_CHECK"

log "=== ALL CHECKS PASSED ==="
echo "Instance $INSTANCE_ID is fully provisioned with blender-mcp ready."
echo "The lease manager flow should work with this timing."
