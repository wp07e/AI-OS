---
name: blender
description: >
  Create 3D scenes and renders on an on-demand GPU instance via the blender-mcp
  tools. GPU acquisition, release, and recovery are automatic and owned by the
  host. The agent drives scene work directly via the `blender` MCP tools; the
  helper script (container/blender/run.py) owns only lease bootstrap
  verification and headless batch render.
---

# Blender Studio Automation

GPU acquisition, release, and recovery are **automatic** and owned by the host.
You do NOT call vast.ai, SSH, or destroy anything. The lease prefill (silent,
prepended to your messages) tells you the current GPU state.

## What you do

| Task | Executor | How |
|---|---|---|
| **Scene work** (create/modify objects, materials, textures, Poly Haven assets, camera) | **You**, via the `blender` MCP tools | `create_object`, `modify_object`, `set_material`, `set_texture`, `execute_code`, `get_render`, `download_polyhaven_asset`, etc. |
| **Save the scene** | **You**, via `execute_code` | `bpy.ops.wm.save_as_mainfile(filepath="/root/blender/scene.blend")` |
| **Viewport grab** | **You**, via `get_render` | Returns an image you can see |
| **Final batch render** | The render route → helper script | The user clicks "Render" in the UI; the script runs `op:"render"` |
| **GPU lifecycle** (acquire/release/recover) | The host lease manager | Automatic — never touch it |

## GPU lease states

The lease prefill tells you which state you're in:

| State | What to do |
|---|---|
| `none` / `queued` / `provisioning` / `recovering` | Do NOT call blender tools yet. Tell the user the GPU is being acquired automatically. |
| `ready` | Proceed with scene work via blender tools. |
| `releasing` | Do not start new work; the GPU is being released. |

If a blender tool returns a **connection-refused** error, the GPU is not ready.
Tell the user it's being acquired and will be ready shortly — do NOT retry in a
tight loop.

## How to work

1. **Read context first.** Read `memory.md` and `state.json` in the instance
   folder (`/workspace/blends/<id>/`) if they exist, to pick up where a
   previous session left off. The host has already pushed the saved `scene.blend`
   onto the GPU instance on acquire-with-resume, so Blender opens at the last
   save.

2. **Drive scene work via blender tools.** Create objects, apply materials, load
   Poly Haven HDRIs/textures/models, set up cameras — all through the `blender`
   MCP tools. Use `execute_code` for anything the specialized tools don't cover
   (it runs arbitrary `bpy` Python in Blender).

3. **Save frequently.** After any meaningful change, call `execute_code` with:
   ```python
   import bpy
   bpy.ops.wm.save_as_mainfile(filepath="/root/blender/scene.blend")
   ```
   The host periodically syncs this `.blend` back to the workspace, bounding
   data loss if the GPU instance dies.

4. **Produce a quick preview after every meaningful change** so the user sees
   visual feedback in the canvas immediately. Do a fast EEVEE render (not a full
   Cycles batch) and update state.json to point at it. Run this via
   `execute_code`:
   ```python
   import bpy, os
   scene = bpy.context.scene
   scene.render.engine = 'BLENDER_EEVEE_NEXT'
   scene.eeveee.taa_render_samples = 16
   scene.render.resolution_x = 960
   scene.render.resolution_y = 540
   scene.render.image_settings.file_format = 'PNG'
   os.makedirs('/root/blender/renders', exist_ok=True)
   scene.render.filepath = '/root/blender/renders/preview.png'
   bpy.ops.render.render(write_still=True)
   ```
   Then update `state.json` with a renders[] entry pointing at
   `exports/preview.png` (the host sync pulls it from the GPU instance within
   ~60s):
   ```json
   {"id": "preview", "label": "Preview", "path": "exports/preview.png",
    "thumbPath": "exports/preview.png", "engine": "BLENDER_EEVEE_NEXT", "samples": 16,
    "createdAt": "<ISO>"}
   ```
   This preview overwrites the previous one each time — it is NOT a final
   render. The user can still click "Render" in the UI for a high-quality
   Cycles render at full resolution.

5. **Update state.json** when you reach a milestone (object added, material
   applied, render done). Write at least:
   ```json
   {"phase": "gpu_ready", "lastUpdated": "<ISO>", "errors": [],
    "scene": {"objectCount": N, "engine": "CYCLES", "savedAt": "<ISO>"}}
   ```

5. **Hand off.** When you pause or finish, append a short note to `memory.md`
   describing the scene state so the next session can resume.

## Brand assets

Brand assets selected for this lane (via the Brand wizard) are automatically
pushed to the GPU instance during provisioning. They live at:

    /root/assets/<filename>

where `<filename>` is the original asset filename (e.g. `5311541c-....png`).
To find the exact filenames available, use `execute_code`:
```python
import os
assets = [f for f in os.listdir('/root/assets')] if os.path.isdir('/root/assets') else []
print(f"Available brand assets: {assets}")
```

**DO NOT** try to load assets from `/workspace/brand/assets/` — that path is in
the host app container, NOT on the GPU instance. Only `/root/assets/` is
accessible from Blender's context.

Use them as:
- **Image textures** in Cycles/EEVEE materials — load via
  `bpy.data.images.load('/root/assets/<filename>')`.
- **Decals / logos** mapped onto geometry via texture nodes.

Example (apply a logo texture to a plane):
```python
import bpy
# Create a plane
bpy.ops.mesh.primitive_plane_add(size=2, location=(0, 0, 1))
plane = bpy.context.active_object
# Load the logo texture
img = bpy.data.images.load('/root/assets/my_logo.png')
# Create material with the texture
mat = bpy.data.materials.new(name="LogoMat")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
tex.image = img
mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
plane.data.materials.append(mat)
```

If no assets are in `/root/assets/` (no brand was selected for this lane), tell
the user to select brand assets via the Brand wizard.

## Poly Haven assets (HDRIs, textures, models)

Poly Haven is a library of free, high-quality 3D assets. It's **enabled by
default** on every GPU instance (the addon checkbox `blendermcp_use_polyhaven`
is turned on at startup) and needs **no API key**. Use the blender MCP tools
directly:

- `get_polyhaven_status` / `get_polyhaven_categories` — check it's on, browse categories.
- `search_polyhaven_assets` — find assets by type (`hdris`, `textures`, `models`, `all`) and category.
- `download_polyhaven_asset` — download an asset by id + type + resolution into the scene.
- `set_texture` — apply a downloaded Poly Haven texture to an object.

If `get_polyhaven_status` ever reports "disabled" (e.g. a scene was loaded that
reset the checkbox), re-enable it yourself via `execute_code`:
```python
import bpy
bpy.context.scene.blendermcp_use_polyhaven = True
```
then retry the polyhaven tool.

## Renders

There are two kinds of renders:

1. **Quick preview** (you do this automatically): After every meaningful scene
   change, run a fast EEVEE render (step 4 above) and update state.json so the
   user sees immediate visual feedback in the canvas. This overwrites the
   previous preview each time.

2. **Final batch render** (user-triggered): The user clicks "Render" in the UI,
   which runs the deterministic helper script with `op:"render"`. This does a
   full Cycles render at the chosen samples/resolution and appends to the
   renders gallery. You do NOT trigger this yourself unless the user explicitly
   asks via chat.

### If a render is stuck at "starting"

When the user clicks Render, the route writes `phase:"starting"`, then the
script writes `bootstrapping`, then `rendering`, then `complete`. If
`state.json` stays at `starting` for more than ~60 seconds with **no**
`bootstrapping` transition, the launch itself failed (the script never started)
— common cause: the pipeline venv / a permission error. Read the launch log:
```
<instance folder>/pipeline.log
```
(e.g. `/workspace/blends/<id>/pipeline.log`) — its tail will show the failure.
Report the error to the user; do not retry the render in a loop. (The wrapper
around the launch also writes `phase:"error"` with the log tail automatically,
so you may already see it in `state.json`'s `errors[]`.)

## Verify your work (before reporting a scene change as done)

A scene can look "built" in the object list but be invisible in render — a
0-vertex mesh from a failed edit, a camera pointing at the subject's back, a
detached head, a blank preview. The low-res 16-sample feedback preview is too
coarse to catch these. Before you tell the user a change is done, run two
checks:

1. **Higher-quality verification preview** — render a sharper EEVEE snapshot
   specifically for verification (distinct from the quick feedback preview),
   then save it as the preview so the canvas and the vision check both see it:
   ```python
   import bpy, os
   scene = bpy.context.scene
   scene.render.engine = 'BLENDER_EEVEE_NEXT'
   scene.eeveee.taa_render_samples = 64      # higher quality for verification
   scene.render.resolution_x = 1280          # larger, so small defects show
   scene.render.resolution_y = 720
   scene.render.image_settings.file_format = 'PNG'
   os.makedirs('/root/blender/renders', exist_ok=True)
   scene.render.filepath = '/root/blender/renders/preview.png'
   bpy.ops.render.render(write_still=True)
   ```
   Then update `state.json` `renders[]` `samples` to 64 so the UI reflects it.

2. **Vision check** — verify framing, blank output, and detached/misaligned
   parts with the free vision MCP tool:
   ```
   vision.analyze_image(
     prompt="Look at this 3D render. Is the subject fully formed and correctly "
            "assembled (no detached/floating parts, no missing pieces)? Is the "
            "camera pointing at the subject's intended front, not its back? Is "
            "any region blank or solid-colored? Describe any defects.",
     image_paths=["/workspace/blends/<id>/exports/preview.png"]
   )
   ```
   The `vision` MCP uses a **free** OpenRouter Qwen2.5-VL model. If it errors
   (free-tier rate limit / unavailability), fall back to the sharper paid check:
   `grok.chat_with_vision(..., detail="high")`.

3. **Mesh sanity** — confirm every mesh has geometry via `execute_code` (a
   0-vertex mesh is corrupted and invisible in render):
   ```python
   import bpy
   for o in bpy.data.objects:
       if o.type == 'MESH':
           v, f = len(o.data.vertices), len(o.data.polygons)
           print(f"{o.name}: verts={v} faces={f}")
           if v == 0: print(f"  ⚠ {o.name} has ZERO vertices — corrupted; rebuild it")
   ```

If any check fails, fix the scene before declaring success — do not report
"done" on an unverified render. These checks catch exactly the failure modes
(corrupted 0-vertex mesh, detached parts, camera facing the wrong way) that
have burned sessions before.

## Translating user requests

| User says | Do this |
|---|---|
| "Add a red cube" | `create_object` (cube) → `set_material` (red) → save → **preview render** → update state.json |
| "Make it metallic" | `execute_code`: set metallic/roughness → save → **preview render** |
| "Load a Poly Haven HDRI" | `search_polyhaven_assets` (hdris) → `download_polyhaven_asset` → **preview render** |
| "Apply my brand logo to the box" | `execute_code`: list `/root/assets/`, `bpy.data.images.load('/root/assets/<logo>')`, create texture material → assign to object → **preview render** |
| "Render it" (final quality) | Tell the user to click the Render button (or run the script with `op:"render"` if they insist) |
| "What does it look like?" | `get_render` → describe what you see, or show the latest preview |

## Resume

Before acting, read `memory.md` and `state.json`. The host has already pushed
`scene.blend` up on acquire-with-resume, so Blender opens at the last save. If
`state.json` shows `phase: "gpu_ready"`, the bootstrap has verified the
connection — you're good to go.
