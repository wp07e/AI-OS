# GPU instance bootstrap (`container/gpu/`)

The files here provision the **ephemeral GPU instance** rented on vast.ai for
the Blender workflow. The OpenCode container is *not* the GPU host — Blender
runs on a separate vast.ai instance reached over an SSH tunnel (see
`web/src/lib/gpu/lease-manager.ts`).

## Files

- **`onstart.sh`** — the `--onstart` script passed to `vastai create instance`.
  Runs as root on every instance start (including start-from-paused). Installs
  Blender + Xvfb, verifies CUDA, drops in the blender-mcp add-on, launches
  Blender with the add-on's socket server bound to `0.0.0.0:9876`, and writes a
  readiness sentinel (`/root/.blender-mcp-ready`) when the socket is listening.
  Idempotent — safe to re-run on restart.
- **`addon.py`** — the [blender-mcp fork](https://github.com/wp07e/blender-mcp)
  Blender add-on (pinned to the `fix/viewport-bytes` SHA on the wp07e fork, which
  returns viewport screenshots as base64 over the socket so the MCP server can
  decode them without a shared filesystem), baked into the OpenCode container
  image at `/app/gpu/addon.py` at build time, then scp'd onto each GPU instance
  by the lease manager and imported by `onstart.sh`. (Downloaded during the image
  build in the Dockerfile — Part 2.1.)

## Network topology

```
OpenCode container                GPU instance (vast.ai, ephemeral)
─────────────────────             ──────────────────────────────────
blender-mcp MCP server   ──SSH tunnel──►  Blender + add-on
(127.0.0.1:9876)          (-NfL 9876)      (0.0.0.0:9876, loopback only)
```

The tunnel is started *inside* the OpenCode container by the lease manager on
acquire, and killed on release. Because `blender-mcp` always dials
`127.0.0.1:9876`, leases can come and go with **no dynamic MCP config and no
OpenCode restart** — only the tunnel changes.

## Security

The Blender socket has **no authentication** (it can execute arbitrary Python).
It is bound to `0.0.0.0` on the GPU instance but the instance's port 9876 is
**never published** via vast `--ports`. The only thing that can reach it is the
SSH tunnel, which uses a host-generated key injected per-lease. Treat the
socket like an open root shell — keep it off the public internet.
