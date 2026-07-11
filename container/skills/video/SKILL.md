---
name: video
description: >
  Generate and assemble video clips and images via a deterministic pipeline
  script. The agent's job is to translate the user's request into a
  request.json and run ONE script; the script owns all xAI (Grok) generation,
  ffmpeg continuity/assembly, downloads, and state writes. NL edits also route
  through the script (never call generation tools or ffmpeg directly).
---

# Video Studio Automation

This workflow has a **single executor** for every action:

| Phase | Executor | Why |
|---|---|---|
| **All generation, edit, extend, assemble** | Deterministic Python script (`/app/video/`) | Fixed operations, eliminates model-to-model variance, owns timing + downloads + ffmpeg |

**You do NOT call `grok.generate_video`, `grok.generate_image`, `grok.extend_video`, or ffmpeg yourself.** They are owned by the script. For any action — generate, edit, extend, assemble, regenerate, delete, include/exclude — you write a `request.json` and run the script. Calling generation tools yourself reintroduces the variance (freelancing, wrong model, missing downloads, inconsistent state) that the script exists to eliminate.

---

## The storyboard model

An instance is a **storyboard of independent clips**. Each clip is generated/edited on its own. At the end, an **Assemble** step concatenates the included clips (in filmstrip order) into one final video.

### Three continuity semantics

| Action | How | Continuity |
|---|---|---|
| **New clip** (`continuity: "none"`) | text-to-video or image-to-video from scratch | None (hard cut) |
| **Continue from last frame** (`continuity: "last_frame"`) | script extracts the last frame of `sourceClipIndex` via ffmpeg → uses it as the starting image for a new clip | Visual continuity at the cut; each clip keeps its own prompt |
| **Extend** (`continuity: "extend"`) | xAI's native extend on one clip's `sourceUrl` | Seamless; no prompt change mid-clip |

---

## Model & quality mapping

A Quality toggle selects the model; resolution is separate.

| Modality | Quality | Model | Inputs | Constraint |
|---|---|---|---|---|
| Image | low | grok-imagine-image | Text, Image refs | — |
| Image | high | grok-imagine-image-quality | Text, Image refs | — |
| Video | low | grok-imagine-video | Text **or** Image | supports text-to-video |
| Video | high | grok-imagine-video-1.5 | **Image only** | **requires a starting image** |

When `quality: "high"` for video and no starting image is given, the script auto-generates a seed frame first (image-to-video). High-quality video always works.

---

## Brand assets

Brand assets (selected via the lane's Brand wizard) are available as references for both image and video generation. They live at `/workspace/brand/assets/<id>.<ext>`. Pass their **ids** in `request.json["references"]`; the script resolves them to paths. Three usage patterns:

1. **Direct frame** — a brand asset id as `startImageExport` → the script uses it as the starting image for image-to-video.
2. **Style/subject reference** — brand asset ids in `references[]` → passed as `reference_image_paths` to guide generation.
3. **Seed source** — brand asset ids in `references[]` + a `seedPrompt` → the script generates an intermediate starter image using them, then animates it.

---

## Status contract

The canvas polls `state.json` every ~2.5s. The **script writes it** at each phase boundary — you don't. You only read it to report outcome.

Phase values: `idle` → `preparing` → `generating` (or `assembling`) → `downloading` → `complete` (or `error`).

State fields the canvas reads: `mode`, `active` (`{op, label, targetIndex}`), `clips[]`, `images[]`, `finalVideo`.

---

## How to run the script

Write `<instance_folder>/request.json`, then run:

```bash
uv run --project /app/video python /app/video/run.py '<instance_folder>' --request request.json
```

Fire-and-forget form (when you don't need to relay output): prefix with `nohup ... > '<instance_folder>/pipeline.log' 2>&1 &`.

### request.json shapes

**Generate a video clip:**
```json
{
  "op": "generate_video",
  "prompt": "<shot description>",
  "quality": "low",
  "settings": { "duration": 6, "aspect_ratio": "16:9", "resolution": "720p" },
  "references": ["<brand-asset-id>", "..."],
  "continuity": "none",
  "seedPrompt": "<optional, for generate-seed>",
  "startImageExport": "<optional: brand asset id OR exports/img-01.png>"
}
```
For "continue from last frame": set `"continuity": "last_frame"`, `"sourceClipIndex": <n>`.

**Extend a clip:**
```json
{
  "op": "extend_video",
  "prompt": "<what happens next>",
  "quality": "low",
  "settings": { "duration": 5 },
  "sourceClipIndex": <n>,
  "continuity": "extend"
}
```

**Generate / edit an image:**
```json
{
  "op": "generate_image",
  "prompt": "<image description>",
  "quality": "low",
  "settings": { "aspect_ratio": "1:1", "resolution": "1k", "n": 1 },
  "references": ["<brand-asset-id>"]
}
```
Use `op: "edit_image"` when references are provided (it passes them as edit sources).

**Assemble the final video:**
```json
{ "op": "assemble", "clipIndices": [0, 1, 3] }
```
Omit `clipIndices` to assemble all included clips in order.

---

## Translating user requests

| User says | Do this |
|---|---|
| "Make a video of X" (no image) | `generate_video`, `quality: low` (text-to-video), or `high` with auto-seed |
| "Animate this photo" / "use my brand photo" | `generate_video` with the asset id as `startImageExport` (image-to-video) |
| "Continue the last clip" / "next shot" | `generate_video` with `continuity: "last_frame"`, `sourceClipIndex` = last clip |
| "Make clip 2 longer" / "extend it" | `extend_video` with `sourceClipIndex` = 1 |
| "Redo clip 3 in high quality" | `generate_video` with the same prompt + `quality: "high"` (replaces via same index after delete) |
| "Assemble the video" / "combine the clips" | `assemble` |
| "Include/exclude clip N" | Edit `state.json` directly: set `clips[N].included` (this is a metadata flip — no script needed) |
| "Delete clip N" | Remove `clips[N]` + its file from `state.json` (no script needed) |
| "Generate an image of X" | `generate_image` (or `edit_image` if referencing a brand asset) |

---

## Resume

Before acting, read `memory.md` and `state.json` in the instance folder to pick up where a previous session left off. When you pause or finish, append a short handoff note to `memory.md`.

All paths are relative to the instance folder unless absolute.

---

## Automation Mode

When the user triggers an automation (via the ✨ AI icon on the video lane), you receive a chat message with automation context prepended. The message tells you to run a video automation.

### What you do:

1. Read `automation_request.json` from the instance folder — it contains the full configuration (clip count, duration, resolution, quality, per-clip assets, base story).
2. Read `brand_selection.json` to see which brand assets are available for this lane.
3. For each asset the user assigned to clips (brand assets or uploads), call `grok.chat_with_vision` to understand what the asset is (logo, photo, character, scene, etc.). Pass the asset path from `/workspace/brand/assets/<id>.<ext>` or the instance's `uploads/` folder.
4. Write `storyboard.json` to the instance folder with per-clip prompts based on:
   - The base story line (if provided)
   - Your understanding of the analyzed assets
   - Per-clip hint prompts (if the user provided them)
   - Continuity settings (none / last_frame)
5. Post a progress message to chat: "Analyzed N assets, wrote storyboard for N clips. Starting generation..."
6. Run the script:
   ```bash
   uv run --project /app/video python /app/video/run.py '<instance_folder>' --request automation_request.json
   ```
   Use the fire-and-forget form (nohup ... &) since generation takes a long time.

### What you do NOT do:

- You do NOT call generation tools (`grok.generate_video`, `grok.generate_image`, `grok.extend_video`)
- You do NOT call ffmpeg
- You do NOT write `state.json` (the script owns that)
- The ONLY new tool you use is `grok.chat_with_vision` for asset analysis

### storyboard.json format

```json
{
  "clips": [
    {
      "index": 0,
      "prompt": "Detailed shot description based on the story and analyzed assets...",
      "quality": "low",
      "settings": { "duration": 6, "aspect_ratio": "16:9", "resolution": "720p" },
      "continuity": "none",
      "references": ["<brand-asset-id>", "..."],
      "startImageExport": "<brand-asset-id or null>",
      "seedPrompt": null
    },
    {
      "index": 1,
      "prompt": "Next shot description...",
      "quality": "low",
      "settings": { "duration": 6, "aspect_ratio": "16:9", "resolution": "720p" },
      "continuity": "last_frame",
      "sourceClipIndex": 0,
      "references": [],
      "seedPrompt": null
    }
  ],
  "storySummary": "One-sentence summary of the overall story",
  "analyzedAssets": {
    "<brand-asset-id>": "Description of what the asset depicts"
  }
}
```

Each clip's fields map directly to the `request.json` shape the script's `generate_video` op understands. The `references` field takes brand asset ids; the script resolves them to file paths. Use `startImageExport` when a specific asset should be the starting frame (image-to-video).

### Story writing guidelines — READ CAREFULLY

**CRITICAL: The clips must form ONE connected story, not independent scenes.**

Follow this process:

1. **Write the full story arc FIRST.** Before writing any individual clip prompts, decide the complete narrative from beginning to end. What happens in clip 1 flows into clip 2, which flows into clip 3, etc. Think of it as a single short film broken into shots — not a collection of unrelated videos.

2. **Then break the story into per-clip prompts.** Each clip's prompt describes one shot/segment of that continuous story. A viewer watching the clips back-to-back should see a coherent narrative unfold.

3. **For clips with `continuity: "last_frame"`:** The prompt MUST describe what happens NEXT — continuing directly from where the prior clip ended. The prior clip's last frame becomes the visual starting point (the script handles this automatically), so your prompt should describe the NEXT action, not restart the scene. You MUST also set `sourceClipIndex` to the prior clip's index.

4. **For clips with `continuity: "none"`:** The prompt starts a fresh scene. This is a hard cut — the visual and narrative can shift entirely.

5. **Be creative.** If the base story is "funny," write prompts that are actually funny — comedic timing, visual gags, character reactions. The AI generates what you describe, so make it vivid and entertaining.

**Example — 3-clip connected story (base story: "funny dog at a coffee shop"):**

```json
{
  "storySummary": "A dog enthusiastically orders a coffee, gets confused by the menu, and dramatically enjoys its first sip.",
  "clips": [
    {
      "index": 0,
      "prompt": "A golden retriever wearing a tiny scarf pushes open the door of a cozy coffee shop with its paw, bell jingling. The dog trots eagerly toward the counter, tail wagging. Warm morning light streams through the windows. The coffee shop logo is visible on the window.",
      "continuity": "none",
      "references": ["<logo-asset-id>"],
      "startImageExport": "<logo-asset-id>"
    },
    {
      "index": 1,
      "prompt": "The golden retriever stands on its hind legs at the counter, tilting its head in confusion at the chalkboard menu above. A barista cat in an apron watches with raised eyebrows. The dog's eyes dart back and forth between options, clearly overwhelmed. Comedic head-tilt energy.",
      "continuity": "last_frame",
      "sourceClipIndex": 0
    },
    {
      "index": 2,
      "prompt": "The golden retriever is now sitting at a small table, holding a steaming coffee cup between its paws. It takes a careful sip, eyes go wide with delight, ears perk up, and the tail starts wagging furiously. The dog looks around as if discovering the meaning of life. Heartwarming and funny.",
      "continuity": "last_frame",
      "sourceClipIndex": 1
    }
  ]
}
```

Notice how each clip's prompt describes the NEXT thing that happens — the story flows continuously. Clip 2 picks up where clip 1 left off (dog at the counter, having just entered), and clip 3 picks up from clip 2 (dog now sitting with coffee, having been at the counter).

**For clips with `assetMode: "ai"`**, don't assign brand assets — let the script generate seed frames from your prompt.

**`sourceClipIndex` is REQUIRED for every `last_frame` clip.** Set it to the index of the prior clip (e.g., clip 1's sourceClipIndex is 0, clip 2's is 1, etc.).
