#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# GPU instance bootstrap script (run as root on every vast.ai instance start).
#
# This is the `--onstart-cmd` script passed to `vastai create instance`. It runs
# as root, after vast's entrypoint has initialized the container and passed through
# the GPU. It downloads Blender 4.x (apt only has 3.0.1 on Ubuntu 22.04), verifies
# CUDA, drops in the blender-mcp add-on, launches Xvfb + Blender with the add-on's
# socket server listening, and writes a readiness sentinel when the socket is
# reachable.
#
# Idempotent: safe to re-run on restart (vast re-runs --onstart-cmd on every
# start, including start-from-paused). Blender download/install is guarded.
#
# Logs to /root/onstart.log.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

LOG=/root/onstart.log
BLENDER_PORT="${BLENDER_PORT:-9876}"
ADDON_SRC="${ADDON_SRC:-/app/gpu/addon.py}"
# The addon ref to download if the baked copy isn't present. Defaults to the
# wp07e fork's fix/viewport-bytes SHA (set via BLENDER_MCP_REF in the GPU image).
ADDON_REF="${BLENDER_MCP_REF:-5519e5550023dc2f3ecacd2df1baee92e143777f}"
# Blender version to install. Defaults to a pinned recent release. Set to a
# specific version (e.g. "4.5.11") or "latest-4.5" to auto-resolve.
BLENDER_VERSION="${BLENDER_VERSION:-4.5.11}"
SENTINEL=/root/.blender-mcp-ready
BLENDER_INSTALL_DIR="/opt/blender"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG" >&2; }

log "=== blender GPU onstart beginning ==="

# ── 0. Inject the SSH public key (passed via --env GPU_SSH_PUBKEY) ──────────
# vast.ai's own key management is unreliable for attaching keys post-creation.
# Instead, we pass the container's pubkey as an env var at creation time and
# inject it directly into authorized_keys here. This runs BEFORE anything else
# so SSH is accessible as early as possible.
if [ -n "${GPU_SSH_PUBKEY:-}" ]; then
  mkdir -p /root/.ssh
  echo "$GPU_SSH_PUBKEY" >> /root/.ssh/authorized_keys
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/authorized_keys
  log "injected SSH public key from GPU_SSH_PUBKEY env var"
else
  log "WARNING: GPU_SSH_PUBKEY not set — SSH key injection skipped"
fi

# ── 1. System packages (idempotent) ─────────────────────────────────────────
# NOTE: vast.ai instances created with --ssh ALREADY have openssh-server
# configured. Do NOT install it here.
export DEBIAN_FRONTEND=noninteractive
NEED_APT=0
command -v xvfb-run >/dev/null 2>&1 || NEED_APT=1
command -v curl >/dev/null 2>&1 || NEED_APT=1
[ -f /usr/lib/x86_64-linux-gnu/libGL.so.1 ] 2>/dev/null || NEED_APT=1
if [ "$NEED_APT" -eq 1 ]; then
  log "installing system deps (xvfb, libGL, curl, pip)..."
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    xvfb \
    libgl1 \
    libxi6 \
    libxrender1 \
    libxxf86vm1 \
    libxfixes3 \
    libxkbcommon0 \
    libsm6 \
    libegl1 \
    libopengl0 \
    python3-pip \
    ca-certificates \
    curl \
    xz-utils \
    >>"$LOG" 2>&1
else
  log "system deps already installed; skipping apt"
fi

# ── 2. Install Blender 4.x (download from blender.org, NOT apt which has 3.0.1)
# Resolve "latest-4.x" to a concrete version if needed.
resolve_blender_version() {
  local ver="$1"
  if [[ "$ver" == latest-4.* ]]; then
    local major="${ver#latest-}"
    log "resolving latest Blender $major..."
    ver=$(curl -fsSL "https://download.blender.org/release/Blender${major}/" 2>/dev/null \
      | grep -o "blender-${major}\.[0-9]*-linux-x64\.tar\.xz" \
      | sort -Vu | tail -1 | sed "s|blender-\(${major}\.[0-9]*\)-linux-x64\.tar\.xz|\1|")
    log "resolved to $ver"
  fi
  echo "$ver"
}

BLENDER_VERSION=$(resolve_blender_version "$BLENDER_VERSION")
log "using Blender $BLENDER_VERSION"

BLENDER_BIN="$BLENDER_INSTALL_DIR/blender"
if [ ! -x "$BLENDER_BIN" ]; then
  log "downloading Blender $BLENDER_VERSION..."
  DL_URL="https://download.blender.org/release/Blender${BLENDER_VERSION%.*}/blender-${BLENDER_VERSION}-linux-x64.tar.xz"
  log "URL: $DL_URL"
  curl -fsSL "$DL_URL" -o /tmp/blender.tar.xz || {
    # Try mirror if main is slow
    log "main download failed; trying mirror..."
    curl -fsSL "https://mirror.clarkson.edu/blender/release/Blender${BLENDER_VERSION%.*}/blender-${BLENDER_VERSION}-linux-x64.tar.xz" -o /tmp/blender.tar.xz
  }
  log "extracting..."
  mkdir -p "$BLENDER_INSTALL_DIR"
  tar -xf /tmp/blender.tar.xz -C /tmp/
  # The archive extracts to blender-<version>-linux-x64/
  cp -a /tmp/blender-${BLENDER_VERSION}-linux-x64/* "$BLENDER_INSTALL_DIR/"
  rm -rf /tmp/blender.tar.xz /tmp/blender-${BLENDER_VERSION}-linux-x64
  log "blender installed at $BLENDER_INSTALL_DIR"
else
  log "blender already installed; skipping download"
fi

# ── 3. CUDA / GPU verification ──────────────────────────────────────────────
log "verifying GPU via nvidia-smi..."
if ! nvidia-smi >/dev/null 2>&1; then
  log "FATAL: nvidia-smi failed — GPU not visible in this instance"
  exit 1
fi
log "GPU visible: $(nvidia-smi -L | head -1)"
log "blender version: $("$BLENDER_BIN" --version 2>/dev/null | head -1)"

# ── 4. Blender Python deps (requests for the addon's asset tools) ───────────
# Blender 4.x bundles its own Python. Find it and install requests into it.
BLENDER_PY="$BLENDER_INSTALL_DIR/$BLENDER_VERSION/python/bin/python3"
if [ ! -x "$BLENDER_PY" ]; then
  # Fallback: find python3 inside the blender dir
  BLENDER_PY=$(find "$BLENDER_INSTALL_DIR" -name "python3" -path "*/python/bin/*" -type f 2>/dev/null | head -1)
fi
log "blender python: ${BLENDER_PY:-not found}"
if [ -x "$BLENDER_PY" ]; then
  if ! "$BLENDER_PY" -c "import requests" >/dev/null 2>&1; then
    log "installing requests into blender's python..."
    "$BLENDER_PY" -m pip install --quiet requests >>"$LOG" 2>&1 || log "WARN: pip install requests failed"
  fi
fi

# ── 5. Install the blender-mcp add-on ───────────────────────────────────────
# The addon.py from blender-mcp is a self-contained single-file addon with its
# own bl_info, register(), and unregister(). Install it as a SINGLE FILE named
# blender_mcp.py in the addons directory (NOT as a package directory — that
# breaks because the file expects to be imported as a top-level module).
BLENDER_MAJOR="${BLENDER_VERSION%%.*}"
BLENDER_MINOR="${BLENDER_VERSION#*.}"
BLENDER_MINOR="${BLENDER_MINOR%%.*}"
BLENDER_CONFIG_ROOT="/root/.config/blender/${BLENDER_MAJOR}.${BLENDER_MINOR}"
ADDONS_DIR="$BLENDER_CONFIG_ROOT/scripts/addons"
mkdir -p "$ADDONS_DIR"

# Install the addon from the SCP'd source. The lease manager SCPs the patched
# /app/gpu/addon.py onto the instance, but that SCP happens in bringInstanceOnline
# AFTER vast.ai boots the instance and kicks off this onstart script — so there is
# a RACE: at this point in onstart the file may not have landed yet. We wait for
# it (up to 90s) so we install the PATCHED addon (with scene-diff interception),
# not the unpatched upstream GitHub copy. Only fall back to GitHub if the SCP
# truly never arrives (e.g. the host died), and warn loudly that the patch is
# absent in that case.
ADDON_WAIT=90
log "waiting up to ${ADDON_WAIT}s for SCP'd addon at $ADDON_SRC..."
for i in $(seq 1 "$ADDON_WAIT"); do
  if [ -f "$ADDON_SRC" ]; then
    # Sanity-check it's our patched addon (has the scene-diff marker), not a
    # stale/empty partial SCP. Without this a half-written file could install
    # a broken addon.
    if grep -q "_format_scene_diff" "$ADDON_SRC" 2>/dev/null; then
      log "installing PATCHED blender-mcp add-on from $ADDON_SRC (ref ${ADDON_REF}, waited ${i}s)..."
      cp "$ADDON_SRC" "$ADDONS_DIR/blender_mcp.py"
      log "patched addon installed at $ADDONS_DIR/blender_mcp.py"
      break
    else
      log "addon present but missing scene-diff marker (partial SCP?); retrying..."
    fi
  fi
  # Last iteration: give up waiting and fall through to the GitHub fallback.
  if [ "$i" = "$ADDON_WAIT" ]; then
    log "WARN: SCP'd addon never arrived at $ADDON_SRC after ${ADDON_WAIT}s — falling back to UPSTREAM (WITHOUT scene-diff patch). Previews/diffs will be degraded."
    REF="$ADDON_REF"
    if [ "$REF" = "main" ]; then
      REF=$(curl -fsSL "https://api.github.com/repos/wp07e/blender-mcp/commits/main" \
        | grep -m1 '"sha"' | sed 's/.*"sha": "\([^"]*\)".*/\1/') || true
    fi
    curl -fsSL "https://raw.githubusercontent.com/wp07e/blender-mcp/${REF}/addon.py" \
      -o "$ADDONS_DIR/blender_mcp.py" || {
        log "FATAL: could not fetch blender-mcp addon"
        exit 1
      }
    log "UPSTREAM (unpatched) addon installed at $ADDONS_DIR/blender_mcp.py"
  fi
  sleep 1
done

# ── 6. Launch Xvfb (virtual display for the add-on + EEVEE) ──────────────────
if ! pgrep -x Xvfb >/dev/null 2>&1; then
  log "starting Xvfb on display :99..."
  Xvfb :99 -screen 0 1280x720x24 >/root/xvfb.log 2>&1 &
  sleep 2
else
  log "Xvfb already running"
fi
export DISPLAY=:99

# ── 7. Launch Blender with the add-on + socket server ───────────────────────
# The blender-mcp addon CANNOT start its server in --background mode (operators
# need a GUI context). We run Blender under Xvfb (virtual display) with a GUI
# so the addon's socket server works. The addon is enabled via a startup script
# that registers it and calls its start_server operator.
pkill -f "blender" 2>/dev/null || true
sleep 1

mkdir -p /root/blender/renders

# Write a startup Python script that Blender will execute on launch.
cat > /root/start_blender_mcp.py <<'PYEOF'
import bpy
import sys
import os

port = int(os.environ.get("BLENDER_PORT", "9876"))

try:
    # Enable the addon via Blender's preferences system. The addon is installed
    # as a single file blender_mcp.py in the scripts/addons directory.
    bpy.utils.refresh_script_paths()
    try:
        bpy.ops.preferences.addon_enable(module="blender_mcp")
        print(f"blender-mcp: addon enabled via preferences", flush=True)
    except Exception as e:
        print(f"blender-mcp: addon_enable failed: {e}", flush=True)

    # Enable Poly Haven integration (free, no key). The addon gates its
    # polyhaven tools behind a scene checkbox defaulting to False; enable it
    # here so the agent can use search_polyhaven_assets / download_polyhaven_asset.
    try:
        bpy.context.scene.blendermcp_use_polyhaven = True  # type: ignore[attr-defined]
        print("blender-mcp: enabled Poly Haven integration", flush=True)
    except Exception as e:
        print(f"blender-mcp: could not enable polyhaven prop: {e}", flush=True)

    # Enable Sketchfab integration. Same gating pattern: the addon registers its
    # sketchfab tools only if this checkbox is True (defaults False). The API
    # key is delivered as env var BLENDERMCP_SKETCHFAB_API_KEY at create-time.
    try:
        bpy.context.scene.blendermcp_use_sketchfab = True  # type: ignore[attr-defined]
        print("blender-mcp: enabled Sketchfab integration", flush=True)
    except Exception as e:
        print(f"blender-mcp: could not enable sketchfab prop: {e}", flush=True)

    # Start the socket server via the addon's operator.
    try:
        bpy.ops.blender_mcp.start_server()  # type: ignore[attr-defined]
        print(f"blender-mcp: server started via operator on port {port}", flush=True)
    except Exception as e:
        print(f"blender-mcp: operator start_server failed: {e}", flush=True)
        # Fallback: import the module directly and call its functions
        try:
            import blender_mcp
            for fn_name in ("start_server", "run_server", "start_mcp_server"):
                fn = getattr(blender_mcp, fn_name, None)
                if callable(fn):
                    try:
                        fn(host="0.0.0.0", port=port)
                        print(f"blender-mcp: server started via {fn_name}", flush=True)
                        break
                    except TypeError:
                        fn(port)
                        print(f"blender-mcp: server started via {fn_name}(port)", flush=True)
                        break
        except Exception as e2:
            print(f"blender-mcp: FATAL - could not start server: {e2}", flush=True)

    # Persist a baseline scene.blend so the host's periodic syncDown always
    # finds a file (even on a fresh instance before the agent makes changes).
    # Without this, scp /root/blender/scene.blend fails with "No such file or
    # directory" until the agent manually saves.
    try:
        bpy.ops.wm.save_as_mainfile(filepath="/root/blender/scene.blend")
        print("blender-mcp: saved baseline scene.blend", flush=True)
    except Exception as e:
        print(f"blender-mcp: WARN could not save baseline scene.blend: {e}", flush=True)
except Exception as e:
    import traceback
    traceback.print_exc()
    print(f"blender-mcp: FATAL - {e}", flush=True)
PYEOF

log "launching Blender (GUI under Xvfb) with blender-mcp on port ${BLENDER_PORT}..."
DISPLAY=:99 BLENDER_PORT=${BLENDER_PORT} "$BLENDER_BIN" --python /root/start_blender_mcp.py >>"$LOG" 2>&1 &

# ── 8. Wait for the socket to be listening, then write the sentinel ─────────
log "waiting for blender-mcp socket on 127.0.0.1:${BLENDER_PORT}..."
for i in $(seq 1 60); do
  if (exec 3<>/dev/tcp/127.0.0.1/${BLENDER_PORT}) 2>/dev/null; then
    exec 3>&- 3<&-
    log "blender-mcp socket is listening after $((i*5))s"
    date -u +%Y-%m-%dT%H:%M:%SZ >"$SENTINEL"
    log "=== blender GPU onstart complete (sentinel written) ==="
    exit 0
  fi
  sleep 5
done

log "FATAL: blender-mcp socket did not come up within 5 minutes"
log "--- last 30 lines of blender output ---"
tail -30 "$LOG" >&2 || true
exit 1
