#!/usr/bin/env python3
"""
Blender pipeline entry point.

Reads request.json from an instance folder and runs the deterministic helper
ops the agent should NOT do itself (lease bootstrap verification, artifact
sync, headless batch render). The agent's INTERACTIVE scene work — creating
objects, applying materials, loading Poly Haven assets — goes through the
`blender` MCP tools directly; this script owns only the non-agent-safe ops.

Usage:
  uv run --project /app/blender python run.py <instance_folder> --request request.json

Ops (request.json["op"]):
  - "bootstrap": verify blender-mcp can reach Blender via the tunnel, write
                  state.json {phase: "gpu_ready"}.
  - "render":    headless batch render. Writes a frame range to
                  /root/blender/renders/ on the GPU instance (via the tunnel),
                  then the host pulls them to exports/. For long unattended
                  renders where tying up the live MCP is wasteful.
  - "sync_down": scp the .blend + renders from the GPU instance to the workspace.
  - "sync_up":   scp the saved .blend from the workspace to the GPU instance.

Exit codes: 0 = complete, 1 = error. Errors are written to state.json's
errors[] before exiting so the canvas surfaces them.

NOTE: This script does NOT name vast.ai, SSH, or any GPU provider. The host
lease manager (web/src/lib/gpu/lease-manager.ts) owns the lease lifecycle. This
script only talks to the local 127.0.0.1:9876 blender-mcp socket (via the
tunnel the host started) or does local file ops.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import traceback
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import state as S  # noqa: E402

BLENDER_HOST = os.environ.get("BLENDER_HOST", "127.0.0.1")
BLENDER_PORT = int(os.environ.get("BLENDER_PORT", "9876"))
RENDER_DIR_REMOTE = "/root/blender/renders"
SCENE_BLEND_REMOTE = "/root/blender/scene.blend"


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _read_request(folder: str, request_name: str) -> dict:
    path = os.path.join(folder, request_name)
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _blender_socket_reachable(timeout: float = 5.0) -> bool:
    """True if the blender-mcp socket on 127.0.0.1:9876 accepts a connection."""
    try:
        with socket.create_connection((BLENDER_HOST, BLENDER_PORT), timeout=timeout):
            return True
    except OSError:
        return False


def _send_to_blender(code: str, timeout: float = 30.0) -> dict:
    """Send an execute_code request to the blender-mcp socket, return the response.

    The blender-mcp add-on speaks a JSON-over-TCP protocol with PERSISTENT
    connections: it sends the response and then loops back to recv() waiting for
    the next command — it does NOT close the socket after responding. So we must
    read until the accumulated bytes parse as a complete JSON object, then close
    our end ourselves. Reading until EOF (the previous approach) deadlocks
    forever because the addon never closes the connection, causing the 600s
    timeout to fire and kill the process (the "pipeline killed by signal 15"
    crash). This read-until-JSON-parses pattern matches the MCP server's own
    receive_full_response implementation.

    Returns {"success": bool, "result": str}.
    """
    payload = json.dumps({"type": "execute_code", "params": {"code": code}}) + "\n"
    try:
        with socket.create_connection((BLENDER_HOST, BLENDER_PORT), timeout=timeout) as sock:
            sock.settimeout(timeout)
            sock.sendall(payload.encode("utf-8"))
            # Read until the accumulated bytes form a complete JSON object, then
            # close our end. This is the fix for the persistent-connection
            # deadlock: the addon never closes the socket, so reading until EOF
            # blocks forever.
            chunks: list[bytes] = []
            while True:
                data = sock.recv(4096)
                if not data:
                    # Connection closed by addon (shouldn't happen normally,
                    # but handle gracefully).
                    break
                chunks.append(data)
                try:
                    raw = b"".join(chunks).decode("utf-8", errors="replace").strip()
                    if raw:
                        result = json.loads(raw)
                        return result
                except json.JSONDecodeError:
                    # Incomplete JSON — need more data. Keep reading.
                    continue
            # Reached only if connection closed before a complete response.
            raw = b"".join(chunks).decode("utf-8", errors="replace").strip()
            return {"success": False, "result": f"incomplete response: {raw[:200]}"}
    except (OSError, socket.timeout) as e:
        return {"success": False, "result": f"socket error: {e}"}


# ── Ops ──────────────────────────────────────────────────────────────────────


def op_bootstrap(folder: str) -> None:
    """Verify blender-mcp is reachable, then write the gpu_ready phase."""
    S.write_state(folder, "provisioning", active={"op": "bootstrap", "label": "Verifying GPU connection"})
    if not _blender_socket_reachable():
        S.write_state(
            folder,
            "error",
            errors=["blender-mcp socket not reachable on 127.0.0.1:9876 — tunnel may be down"],
        )
        sys.exit(1)
    # Ask Blender for scene info to confirm the add-on responds.
    resp = _send_to_blender("import bpy; print(len(bpy.data.objects))")
    obj_count = 0
    if resp.get("success"):
        try:
            obj_count = int(resp.get("result", "0").strip().split("\n")[-1])
        except (ValueError, IndexError):
            pass
    engine = "CYCLES"  # default; could be queried from bpy.context.scene.render.engine
    S.write_state(
        folder,
        "gpu_ready",
        scene={"objectCount": obj_count, "engine": engine, "savedAt": _now_iso()},
        active=None,
    )
    S.append_memory(folder, "GPU lease acquired and blender-mcp verified.")


def op_render(folder: str, request: dict) -> None:
    """Headless batch render via the blender-mcp socket.

    Writes frames to RENDER_DIR_REMOTE on the GPU instance. The host lease
    manager's periodic sync (or the release sync) pulls them to exports/.
    Settings: engine, samples, resolution, frame_start, frame_end.
    """
    settings = request.get("settings", {})
    engine = settings.get("engine", "CYCLES")
    samples = int(settings.get("samples", 128))
    resolution = settings.get("resolution", "1080p")
    frame_start = int(settings.get("frame_start", 1))
    frame_end = int(settings.get("frame_end", 1))

    res_map = {"720p": (1280, 720), "1080p": (1920, 1080), "1440p": (2560, 1440), "4k": (3840, 2160)}
    res_x, res_y = res_map.get(resolution, (1920, 1080))

    S.write_state(folder, "rendering", active={"op": "render", "label": f"Rendering {frame_start}-{frame_end} ({engine}, {samples} samples)"})

    code = f"""
import bpy, os
scene = bpy.context.scene
scene.render.engine = '{engine}'
if '{engine}' == 'CYCLES':
    scene.cycles.samples = {samples}
    scene.cycles.device = 'GPU'
scene.render.resolution_x = {res_x}
scene.render.resolution_y = {res_y}
scene.render.image_settings.file_format = 'PNG'
os.makedirs('{RENDER_DIR_REMOTE}', exist_ok=True)
scene.render.filepath = '{RENDER_DIR_REMOTE}/render_'
scene.frame_start = {frame_start}
scene.frame_end = {frame_end}
bpy.ops.render.render(animation=True, write_still=True)
print('RENDER_DONE')
"""
    resp = _send_to_blender(code, timeout=600.0)
    if resp.get("status") == "error":
        S.write_state(folder, "error", errors=[f"render failed: {resp.get('message', 'unknown')}"])
        sys.exit(1)
    if not resp.get("success") and not resp.get("status") == "success":
        S.write_state(folder, "error", errors=[f"render failed: {resp.get('result', resp.get('message', 'unknown'))}"])
        sys.exit(1)

    S.write_state(
        folder,
        "complete",
        active=None,
        errors=[],
        renders=[{
            "id": f"render-{int(time.time())}",
            "label": f"{engine} {samples}s {resolution}",
            "path": f"exports/render_{frame_start:04d}.png",
            "thumbPath": f"exports/render_{frame_start:04d}.png",
            "engine": engine,
            "samples": samples,
            "createdAt": _now_iso(),
        }],
    )
    S.append_memory(folder, f"Rendered frames {frame_start}-{frame_end} ({engine}, {samples} samples, {resolution}).")


def op_preview(folder: str, request: dict) -> None:
    """Quick EEVEE preview via the blender-mcp socket (NOT the MCP bridge).

    The agent's interactive `execute_code` previews are bound by the blender
    MCP bridge's ~120s timeout, which complex scenes exceed — forcing the agent
    to drop to 640x360 and hobbling its vision checks. This op uses the same
    direct-socket path as op_render (`_send_to_blender`, 600s timeout), so a
    preview can't time out the bridge. It renders a single EEVEE frame to
    RENDER_DIR_REMOTE/preview.png and writes a renders[] preview entry the
    canvas picks up. Overwrites the previous preview.
    """
    settings = request.get("settings", {})
    samples = int(settings.get("samples", 16))
    res_x = int(settings.get("resolution_x", 960))
    res_y = int(settings.get("resolution_y", 540))

    S.write_state(folder, "rendering", active={"op": "preview", "label": f"Preview EEVEE {samples}s {res_x}x{res_y}"})

    code = f"""
import bpy, os
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE_NEXT'
scene.eevee.taa_render_samples = {samples}
scene.render.resolution_x = {res_x}
scene.render.resolution_y = {res_y}
scene.render.image_settings.file_format = 'PNG'
os.makedirs('{RENDER_DIR_REMOTE}', exist_ok=True)
scene.render.filepath = '{RENDER_DIR_REMOTE}/preview.png'
# Use animation=False (single still frame) so Blender writes exactly to the
# filepath without appending a frame number suffix (animation=True produces
# preview.png0001.png, which the host sync doesn't find at exports/preview.png).
bpy.ops.render.render(write_still=True)
print('PREVIEW_DONE')
"""
    resp = _send_to_blender(code, timeout=600.0)
    # The addon returns {"status": "success", "result": {...}} on success, or
    # {"status": "error", "message": "..."} on error. _send_to_blender returns
    # {"success": False, "result": "..."} on socket failure. Check both paths.
    if resp.get("status") == "error":
        S.write_state(folder, "error", errors=[f"preview failed: {resp.get('message', 'unknown')}"])
        sys.exit(1)
    if not resp.get("success") and not resp.get("status") == "success":
        S.write_state(folder, "error", errors=[f"preview failed: {resp.get('result', resp.get('message', 'unknown'))}"])
        sys.exit(1)

    # Return to the idle-ready phase (not "complete", which the UI treats as a
    # final render). Clear errors so stale messages from prior failed runs don't
    # linger in the canvas. The renders[] entry is what the canvas displays.
    S.write_state(
        folder,
        "gpu_ready",
        active=None,
        errors=[],
        renders=[{
            "id": "preview",
            "label": "Preview",
            "path": "exports/preview.png",
            "thumbPath": "exports/preview.png",
            "engine": "BLENDER_EEVEE_NEXT",
            "samples": samples,
            "createdAt": _now_iso(),
        }],
    )


def op_sync_down(folder: str) -> None:
    """Sync artifacts from the GPU instance to the local workspace.

    This is a marker op — the actual scp is orchestrated by the host lease
    manager (which holds the SSH details). This op exists so the agent can
    request a sync via the script interface if needed. It writes state to
    signal sync progress.
    """
    S.write_state(folder, "gpu_ready", active={"op": "sync_down", "label": "Syncing artifacts"})
    # The host picks this up via the periodic sync / release sync. We just
    # update the timestamp.
    S.write_state(folder, "gpu_ready", active=None)


def op_sync_up(folder: str) -> None:
    """Push the saved .blend from the workspace up to the GPU instance."""
    S.write_state(folder, "gpu_ready", active={"op": "sync_up", "label": "Pushing scene to GPU"})
    S.write_state(folder, "gpu_ready", active=None)


# ── Main ────────────────────────────────────────────────────────────────────


# Track the current folder + op so signal handlers can write a terminal state.
_CURRENT: dict[str, str] = {"folder": "", "op": ""}


def _on_signal(signum: int, frame: object) -> None:
    """Write a terminal error state on SIGTERM/SIGINT so the canvas doesn't
    hang on a stale 'starting'/'rendering' phase if the process is killed
    (e.g. GPU destroyed, container restarted)."""
    folder = _CURRENT.get("folder", "")
    if folder:
        try:
            S.write_state(
                folder,
                "error",
                errors=[f"pipeline killed by signal {signum}"],
                active=None,
            )
        except Exception:
            pass
    sys.exit(130)


signal.signal(signal.SIGTERM, _on_signal)
signal.signal(signal.SIGINT, _on_signal)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: run.py <instance_folder> --request <request.json>", file=sys.stderr)
        return 1
    folder = sys.argv[1]
    _CURRENT["folder"] = folder
    request_name = "request.json"
    for i, arg in enumerate(sys.argv):
        if arg == "--request" and i + 1 < len(sys.argv):
            request_name = sys.argv[i + 1]

    try:
        request = _read_request(folder, request_name)
    except Exception as e:
        traceback.print_exc()
        S.write_state(folder, "error", errors=[f"could not read request: {e}"])
        return 1

    op = request.get("op", "")
    _CURRENT["op"] = op
    # Write a bootstrapping phase immediately so the canvas/agent can tell the
    # process actually started (vs. stuck at the route's "starting" patch from
    # a launch that died before run.py ran, e.g. the .venv permission failure).
    S.write_state(
        folder,
        "bootstrapping",
        active={"op": op, "label": f"Preparing {op}…"},
    )
    try:
        if op == "bootstrap":
            op_bootstrap(folder)
        elif op == "render":
            op_render(folder, request)
        elif op == "preview":
            op_preview(folder, request)
        elif op == "sync_down":
            op_sync_down(folder)
        elif op == "sync_up":
            op_sync_up(folder)
        else:
            S.write_state(folder, "error", errors=[f"unknown op: {op}"])
            return 1
        return 0
    except Exception as e:
        traceback.print_exc()
        S.write_state(folder, "error", errors=[str(e)], active=None)
        return 1


if __name__ == "__main__":
    sys.exit(main())
