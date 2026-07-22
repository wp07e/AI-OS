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

⚠️ **There is ONE Blender process.** Your MCP tools and the user's "Render"
button share its single-threaded addon socket (`127.0.0.1:9876`). Two renders
on the same process corrupt `scene.blend` and hang the bridge. So: the helper
script's `op:render` (the user's "Render" button) owns final renders — you NEVER
trigger a Cycles render or a large EEVEE render yourself via MCP. When a render
is running, the lease prefill will say `phase: rendering` and warn you to touch
nothing; poll `state.json` + `exports/` and resume only once the phase clears.

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

## Modeling methodology (READ BEFORE MODELING)

This section is your **foundational methodology for any modeling task** — read it
before you create or modify geometry. It exists to prevent the two recurring
failure modes: **detached/disconnected parts** on multi-part models, and
**runaway iteration loops that crash Blender**. Follow it every time; do not
improvise past it.

### Step 0 — Skills-first check (MANDATORY, before anything else)

Before planning or touching any geometry, you MUST check the installed technique
skills and read the ones that match the request:

1. Run `ls /workspace/skills/` to see all 94 technique skills.
2. Match the request to the relevant skill(s) and read each one's `SKILL.md`.
3. State in your report which skills you loaded.
4. Do NOT begin modeling until this is done.

Common mappings:

| Request type | Load this skill first |
|---|---|
| Creature / insect / animal / monster | `creature-artist` (has an explicit **Insectoid: Arthropod → segmented body, jointed legs** row — use it for ants, beetles, etc.) |
| General modeling / blockout / cleanup | `blender-modeler` |
| Parametric antennae, legs, cables, segmented parts | `procedural-modeling` |
| Machinery / robots / vehicles | `hard-surface` |
| Sculpted organic detail (scales, pores) | `sculpting` |
| Retopologizing a sculpt | `retopology` |
| Rigging for posing/animation | `rigging` |
| Hair / fur | `hair-groom` |
| Materials / shaders | `materials` |
| Lighting | `lighting` |

These skills contain exact anatomy tables, modifier-stack recipes, and parameter
cheatsheets built by specialists. **Skipping them is the #1 cause of detached
parts and failed builds** — they tell you, for example, that an insect needs a
segmented body with jointed legs parented to a thorax, so you don't build free-
floating parts by accident.

### Step 1 — Plan before operating

Before any Blender operation:
1. Decompose the task into the smallest logical single-step actions.
2. Identify symmetry opportunities (model one side, Mirror the other) and
   reusable/linked geometry (Array, linked duplicates).
3. Decide the assembly hierarchy up front (see the assembly protocol below).
4. Identify existing geometry that can be reused or modified.

**Do not execute any Blender operation during planning.**

### Step 2 — Execute exactly ONE step per tool call, then inspect

Perform only one logical modeling action per step. Good single steps:
- `Create the Thorax mesh`
- `Add a Mirror modifier to Leg_L_Front`
- `Extrude the antenna base`
- `Parent the wing to the Thorax`

Bad (multi-step in one call): "create both legs and the abdomen", "model the
head and apply modifiers at the same time".

After every step, **inspect** (never assume success): correct object(s) exist
with expected names, object count is right, transforms/origin sensible, parent
hierarchy correct, modifiers live and in order, mesh manifold where expected, no
floating/duplicate geometry, scene back in **Object Mode**.

If the step succeeded → next planned step. If not → **stop, diagnose, do not
immediately retry** (see retry caps below).

### Multi-part assembly protocol (PREVENTS DETACHED PARTS)

This is the recipe that stops legs, heads, and wings from floating off the body.
For any model with more than one part:

1. **Create a single root empty (`AssemblyRoot`) as the FIRST step.** Every body
   part will be parented to it (or to its anatomical parent, which is itself
   parented to the root).
2. **Build each segment and parent it immediately** — `Head` → root, `Thorax` →
   root, `Abdomen` → root, each `Leg_*` → `Thorax`, each `Antenna_*` → `Head`.
   **Never leave a part unparented.** Parenting is part of "creating" a part, not
   an afterthought.
3. **Model one side and mirror** for symmetrical pairs. Create `Leg_L_Front`,
   add a Mirror modifier (or linked duplicate), producing `Leg_R_Front`. Do not
   freehand both sides independently — they'll diverge.
4. **Verify connectivity after assembly.** Dump the parent tree and per-object
   vertex counts via `execute_code`:
   ```python
   import bpy
   for o in bpy.data.objects:
       parent = o.parent.name if o.parent else "(NONE)"
       v = len(o.data.vertices) if o.type == 'MESH' else '-'
       print(f"{o.name:24} parent={parent:16} verts={v}")
   ```
   Any `parent=(NONE)` part that should be attached, or any `verts=0` mesh, is a
   defect — fix it before continuing.
5. **Run the vision check** (the "Verify your work" section below) on the
   **assembled whole**, not per-part, to catch floating/misaligned parts.

**A part is not "done" until it is parented and verified connected.**

### Modeling technique footguns (general-purpose)

These are the low-level Blender technique traps that burn first renders on
**any** subject — creatures, characters, vehicles, props. They are not in the
specialist technique skills, so they live here as your baseline guardrails.

**1. Transform application — `transform_apply` zeroes locations.**

The bare `bpy.ops.object.transform_apply()` defaults to `location=True,
rotation=True, scale=True`. Applied to a parented object, it **zeros every
segment's location to (0,0,0)** — head, thorax, and abdomen all collapse to the
origin and the vision system sees one blob. This is the single most common
cause of a collapsed first build.

- **Use `apply_scale_safe(object_name)`** via the blender MCP tools. It applies
  scale only (`location=False, rotation=False`) and verifies the location
  survived.
- If you must use `execute_code`, the ONLY safe form is:
  ```python
  bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
  ```
- **Never** call `transform_apply()` with no keyword args, and never on a
  parented object with `location=True`.

**2. Camera setup — never hand-calculate rotation.**

Hand-calculating camera rotation Euler angles consistently fails (the trig is
wrong) and wastes a full render cycle discovering the camera points the wrong
way. **Every** render needs a camera, so this is subject-independent.

- **Use `aim_camera_at(camera_name, target_name, lens=50)`** via the blender
  MCP tools. It creates a Damped Track constraint so the camera always looks at
  the target regardless of where either is moved.
- **Set up and verify the camera BEFORE building detailed geometry.** A
  `get_viewport_screenshot` costs nothing and catches framing errors 20 minutes
  earlier than a full preview render.
- When a new camera appears, the scene-diff output will nudge you toward
  `aim_camera_at` — heed it.

**3. Viewport-first verification.**

After the first 2–3 parts are assembled (before any detail work), call
`get_viewport_screenshot` to visually confirm framing and assembly. This is the
cheapest verification step available — do **not** wait for the first preview
render to discover a camera or assembly problem. The longer a defect goes
unseen, the more geometry is built on top of it.

**4. Connected vs separate geometry — match the subject's anatomy.**

The right approach depends on the subject's actual anatomy. Read the matching
technique skill (Step 0) for the authoritative anatomy table — if it says
"segmented body," the segments ARE separate and that's correct.

- **Continuous-surface creatures** (slime, worms, blobs, character torsos where
  muscle flows): build as a **single connected mesh** via Edit Mode extrusion +
  scaling, with bridge edge loops between forms. Separate UV spheres look
  disjointed here because the surface should flow continuously.
- **Segmented exoskeleton creatures** (ants, beetles, spiders, crabs — anything
  the anatomy table calls "Insectoid: Arthropod"): **separate segments that
  overlap at the joints** is correct — the exoskeleton segments are genuinely
  distinct rigid plates. The key: the segments must **overlap/connect at the
  petioles** (the thin waist joints), not leave visible gaps. A single blended
  mesh would look wrong for an arthropod.
- **Subjects with distinct rigid parts** (machinery, vehicles, armored
  creatures): separate meshes + the assembly protocol above are correct — the
  gaps are intentional.
- **Organic appendages** (legs, antennae, tentacles, vines, cables): prefer
  **Bezier curves with a circular bevel** over raw cylinders. Curves give
  smooth, natural bends with fewer vertices and articulated joints. Create a
  Bezier curve, set its `bevel_depth` for thickness. **Note:** curves render as
  thin wireframe lines in viewport screenshots until converted to mesh — call
  `bpy.ops.object.convert(target='MESH')` before taking a viewport grab so you
  can verify the actual form.

**5. Subdivision Surface — levels and support loops.**

When using Subdivision Surface on a body form:
- Use viewport level 2 / render level 3.
- Add **support edge loops** (loop cut, Ctrl+R) at segment boundaries so the
  form holds its silhouette under subdivision.
- Bare subdivision on separate primitives still looks like separate primitives
  — subdivide a *connected* mesh for the organic-form benefit to register.

### Retry & iteration caps (PREVENTS INFINITE-LOOP CRASHES)

- **Per step:** maximum **2 retries** for the same logical step. After two
  failures, **STOP**. Report what failed, why, and the smallest recovery option.
  Never enter retry loops or emit near-identical failing operations.
- **Global hard cap: ~25 MCP tool calls for a single modeling task.** If you hit
  the cap, the build is not converging — **STOP**. Do not keep improvising: that
  is what crashes Blender. Instead: save (`bpy.ops.wm.save_as_mainfile`), update
  `state.json` to `{"phase": "needs_input", ...}`, append a note to `memory.md`,
  and hand back to the user with a concise summary of what's done and what's
  stuck. Let the user redirect.

### Scene-integrity & state-hygiene rules

- **Never leave the scene in Edit Mode.** Before and after every op, confirm
  Object Mode and explicitly set the active object/selection — never rely on
  leftover state from a previous step. Leaving Edit Mode or dirty selection is a
  failure.
- **Never** delete/rename/move user objects, reset the scene, apply modifiers,
  recreate existing correct geometry, leave temp objects/empties (except
  `AssemblyRoot`), or touch cameras/lights/world/render settings unless asked.
- **Prefer non-destructive workflows:** keep modifiers live (Subdivision Surface,
  Mirror, Array); prefer modifying/reusing existing geometry over creating new.
- **Descriptive names always:** `Head`, `Thorax`, `Abdomen`, `Leg_L_Front`,
  `Antenna_L`. Never `Cube`, `Cube.001`, `Object`, `Sphere`.
- **Symmetry first:** model one side, mirror the other.
- **Make the smallest possible deterministic change** each step; preserve all
  existing user work.

### Completion criteria (a model is not done until ALL are true)

- [ ] Requested geometry exists and is named correctly
- [ ] **Every part is parented** — no unparented/floating parts (verified by the
      parent-tree dump)
- [ ] Symmetrical pairs are mirrored, not freehanded
- [ ] Mesh vertex counts are non-zero (no corrupted/empty meshes)
- [ ] Hierarchy and origins are sensible
- [ ] **Camera framed via `aim_camera_at` and verified with
      `get_viewport_screenshot`** (never hand-calculated rotation)
- [ ] **The assembled whole passes the vision check** (no detached parts, camera
      framed correctly, no blank regions)
- [ ] No retry loops occurred; you stayed under the ~25-call cap
- [ ] Scene is in Object Mode, fully editable and recoverable

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
   (it runs arbitrary `bpy` Python in Blender). **Prefer purpose-built tools
   over `execute_code` for footgun-prone ops:** `aim_camera_at` for camera
   framing (never hand-calculate rotation) and `apply_scale_safe` for baking
   scale (never `transform_apply()` which zeroes locations). See "Modeling
   technique footguns" above.

3. **Save frequently.** After any meaningful change, call `execute_code` with:
   ```python
   import bpy
   bpy.ops.wm.save_as_mainfile(filepath="/root/blender/scene.blend")
   ```
   The host periodically syncs this `.blend` back to the workspace, bounding
   data loss if the GPU instance dies.

4. **Produce a quick preview after every meaningful change** so the user sees
   visual feedback in the canvas immediately. **Trigger it via the preview
   route**, NOT `execute_code` and **NEVER by invoking run.py yourself**:
   ```
   POST /api/workspace/<id>/blender/preview
   body: {"settings": {"samples": 16, "resolution_x": 960, "resolution_y": 540}}
   ```
   This runs `op:preview` through the helper script, which talks to the same
   Blender socket your MCP tools use but with a **600s budget** and is
   fire-and-forget. Do NOT run the preview via `execute_code`
   (`bpy.ops.render.render`) on anything but a trivial scene — `execute_code`
   goes through the MCP bridge and is capped at **~120s**, so complex scenes
   time out and force you down to an unusably small 640x360.

   **Do NOT invoke `run.py` yourself** (e.g. `uv run --project /app/blender
   python run.py ...`) via `execute_code` or a shell. Doing so blocks the single
   Blender socket the MCP bridge shares, hits the ~120s shell/bridge timeout,
   gets SIGTERM'd (signal 15), and triggers a Blender watchdog restart — exactly
   the crash loop you want to avoid. The HTTP preview route is the ONLY correct
   path: it background-launches run.py (fire-and-forget) with the 600s budget
   and never blocks your socket.

   The preview route has no such ceiling. After POSTing, poll `state.json`
   (phase goes `starting` → `rendering` → `gpu_ready`) and the renders[] preview
   entry; the host syncs `exports/preview.png` from the GPU within ~5s.

   The `execute_code` preview (below) is a fallback ONLY for tiny scenes where
   its 120s limit can't bind:
   ```python
   import bpy, os
   scene = bpy.context.scene
   scene.render.engine = 'BLENDER_EEVEE_NEXT'
   scene.eevee.taa_render_samples = 16
   scene.render.resolution_x = 960
   scene.render.resolution_y = 540
   scene.render.image_settings.file_format = 'PNG'
   os.makedirs('/root/blender/renders', exist_ok=True)
   scene.render.filepath = '/root/blender/renders/preview.png'
   bpy.ops.render.render(write_still=True)
   ```
   Then update `state.json` with a renders[] entry pointing at
   `exports/preview.png`:
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

## Sketchfab models

Sketchfab is a large library of user-uploaded 3D models (many free,
downloadable). It's **enabled by default** on every GPU instance (the addon
checkbox `blendermcp_use_sketchfab` is turned on at startup), and the API key is
configured automatically by the host (no action from you). Use the blender MCP
tools:

- `get_sketchfab_status` — check that integration is on AND the API key is valid (it validates against `/v3/me`). Call this first if anything fails.
- `search_sketchfab_models(query, categories?, count?, downloadable?)` — find models by text. Prefer `downloadable: true` (only those can be fetched). Returns a formatted list with UIDs.
- `get_sketchfab_model_preview(uid)` — fetch the model's thumbnail so you can visually confirm it's the right model before downloading.
- `download_sketchfab_model(uid, target_size)` — download the model AND import it into the scene in one step. **`target_size` is REQUIRED** and is the size in meters for the model's largest dimension (the model is scaled to fit). Pick a sensible value for the real-world object:

  | Subject | target_size (m) |
  |---|---|
  | Small object (cup, phone, fruit) | 0.1 – 0.3 |
  | Chair | 1.0 |
  | Table | 0.75 |
  | Person | 1.7 |
  | Car | 4.5 |

  Rescale afterward via `execute_code` (`bpy.context.scene.objects['<name>'].scale = ...`) if needed.

If `get_sketchfab_status` reports "disabled" on a resumed session (the checkbox
is serialized into scene.blend and a pre-fix blend may carry False), re-enable
it yourself via `execute_code`:
```python
import bpy
bpy.context.scene.blendermcp_use_sketchfab = True
```
then retry. (The host also re-asserts this on resume, but this is the safety net.)

If `get_sketchfab_status` reports the key as missing/invalid, that's a host
configuration issue (the `SKETCHFAB_API_KEY` env var) — tell the user, don't
retry downloads in a loop.

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
   scene.eevee.taa_render_samples = 64      # higher quality for verification
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
| "Add a Sketchfab model" (e.g. a chair) | `get_sketchfab_status` → `search_sketchfab_models` ("chair", downloadable=true) → `get_sketchfab_model_preview` (confirm) → `download_sketchfab_model(uid, target_size=1.0)` → save → **preview render** |
| "Apply my brand logo to the box" | `execute_code`: list `/root/assets/`, `bpy.data.images.load('/root/assets/<logo>')`, create texture material → assign to object → **preview render** |
| "Render it" (final quality) | Tell the user to click the Render button (or run the script with `op:"render"` if they insist) |
| "What does it look like?" | `get_render` → describe what you see, or show the latest preview |

## Resume

Before acting, read `memory.md` and `state.json`. The host has already pushed
`scene.blend` up on acquire-with-resume, so Blender opens at the last save. If
`state.json` shows `phase: "gpu_ready"`, the bootstrap has verified the
connection — you're good to go.
