# Video Automation Design

**Date:** 2026-07-10
**Status:** Approved (pending implementation)
**Depends on:** Video Workflow (V0.2, commit `e78b2bf`)

## Overview

A new "automation" concept that puts 80–90% of the video creation work on the AI. The user configures the full video upfront (clip count, duration, resolution, per-clip assets, base story), clicks Generate, and the system orchestrates the entire production end-to-end: asset analysis, story generation, clip generation, and final assembly.

Automations are triggered by a new AI/sparkle icon on video lanes (alongside the existing brand/paint icon and trash icon). They run within the existing video instance folder and reuse the existing video pipeline, deterministic script, and VideoStudio canvas.

## Architecture — Hybrid coordination model

The automation uses a hybrid of agent intelligence + deterministic script execution:

1. **Agent (DeepSeek + Grok vision)** — analyzes selected brand/uploaded assets using `grok.chat_with_vision`, crafts a per-clip story, and writes `storyboard.json`
2. **Deterministic script (`run.py`)** — reads `storyboard.json`, generates all clips with retry logic, assembles the final video

The existing prohibition on the agent calling generation tools remains unchanged. The only new agent capability is `chat_with_vision` for asset analysis (an analysis tool, not a generation tool). Generation (video/image creation, ffmpeg assembly) stays entirely in the deterministic script.

### Data flow

```
User clicks AI icon → AutomationWizard opens
  ├─ User configures: clip count, per-clip duration, resolution, quality,
  │   per-clip assets (brand/uploaded/AI-generated), continuity, base story
  └─ User clicks "Generate"
      ↓
POST /api/workspace/<id>/video/automate
  ├─ Writes automation_request.json to instance folder
  ├─ Sends visible chat message to agent via /api/tools/message
  │   (with buildAutomationPrefill() prepended, mirroring brand prefill)
  └─ Returns { ok: true } immediately
      ↓
Agent phase (DeepSeek, guided by SKILL.md "Automation Mode" section + prefill):
  1. Reads automation_request.json + brand_selection.json
  2. Calls grok.chat_with_vision on each assigned asset
  3. Writes storyboard.json (per-clip prompts, asset assignments, continuity)
  4. Posts progress to chat ("Analyzed N assets, wrote storyboard for N clips")
  5. Runs: uv run --project /app/video python /app/video/run.py '<folder>' --request automation_request.json
      ↓
Script phase (run.py, op: "automate"):
  1. Reads storyboard.json
  2. For each clip: generate → download → extract poster → write state
     (3 retries per clip, skip on final failure)
  3. Assemble final video from successful clips
  4. Write final state.json (phase: "complete")
      ↓
VideoStudio canvas (polling state.json every 2.5s):
  - Shows clips as they complete (ClipFilmstrip updates live)
  - FinalVideoCard shows assembled video with download button
  - User can edit/regenerate individual clips manually afterward
```

### Key boundary

- **Agent analyzes + writes storyboard** (creative intelligence)
- **Script generates + assembles** (deterministic execution with retry)
- The agent never calls `grok.generate_video`, `grok.generate_image`, `grok.extend_video`, or ffmpeg
- The only new agent tool is `grok.chat_with_vision` (analysis only)

## UI Design

### Lane icon

A third icon (sparkle/AI icon) on video lanes, positioned between the brand icon and trash icon:

```
[ Lane title                    ✨ 🎨 🗑️ ]
                                 AI Brand Trash
```

In `WorkRail.tsx`:
- Brand icon: `absolute right-8` (existing)
- Trash icon: `absolute right-1.5` (existing)
- **New AI icon: `absolute right-14`** (only on `inst.workflow_type === "video"` lanes)

Uses a `SparkleIcon` (inline SVG matching existing icon style). Clicking calls `onOpenAutomationWizard(inst)` — same pattern as `onOpenBrandWizard`.

### AutomationWizard

Mounted at shell level in `AppShell.tsx` (same pattern as `BrandWizard`), keyed to `automationWizardInstance`.

**Step 1 — Overview** (global video settings):
- Clip count (slider: 1–10)
- Duration per clip (slider: 1–15 seconds)
- Overall resolution (select: 480p / 720p / 1080p)
- Quality (toggle: low / high) — note that high = better quality but slower
- Aspect ratio (select: 16:9 / 9:16 / 1:1)
- Base story line (textarea, optional — e.g. "funny talking animals" or leave blank for AI to decide)
- Time estimate warning: "This will take approximately X minutes depending on resolution and clip count"

**Step 2 — Per-clip configuration**:
- A list of clip cards (one per clip count from step 1)
- Each clip card:
  - Clip number + continuity selector (New scene / Continue from last frame)
  - Asset assignment: checkboxes for brand assets (from `brand_selection.json`), upload buttons for one-time images (reusing the existing upload route), or "Let AI create assets" toggle
  - Optional prompt hint per clip (textarea — overrides the base story for this clip)
- A "Apply to all" button to copy settings across clips

**Step 3 — Review & Generate**:
- Summary: N clips, Xs each, resolution, quality, total estimated time
- List of which assets go in which clips
- Warning: "This process may take 10–30+ minutes. You can close this wizard and return later — progress is saved."
- "Generate" button → writes `automation_request.json`, sends the chat message, transitions to progress view

**Progress view** (replaces wizard content after generate):
- Phase indicator: Analyzing assets → Writing storyboard → Generating clip 2/5 → Assembling → Done
- Progress bar
- Elapsed time
- "Close" button (closing doesn't stop the process — state.json tracks progress)

## Data Contracts

### `automation_request.json` (written by the web route)

Input the agent reads to understand what to build:

```json
{
  "op": "automate",
  "clipCount": 5,
  "clipDuration": 6,
  "resolution": "720p",
  "quality": "low",
  "aspectRatio": "16:9",
  "baseStory": "funny talking characters in a coffee shop",
  "clips": [
    {
      "index": 0,
      "continuity": "none",
      "assetMode": "brand",
      "brandAssets": ["<asset-id-1>", "<asset-id-2>"],
      "uploadedAssets": ["uploads/<uuid>.png"],
      "promptHint": "Opening shot, character enters"
    },
    {
      "index": 1,
      "continuity": "last_frame",
      "assetMode": "ai",
      "brandAssets": [],
      "uploadedAssets": [],
      "promptHint": ""
    }
  ],
  "folder": "/workspace/videos/<uuid>",
  "requestedAt": "2026-07-10T..."
}
```

`assetMode` per clip: `"brand"` (use specified assets), `"ai"` (let AI generate assets for the story), `"upload"` (use uploaded one-time images).

### `storyboard.json` (written by the agent after vision analysis)

Detailed per-clip plan the script consumes. Clip specs map directly to the existing `request.json` shape that `_do_video` already understands:

```json
{
  "clips": [
    {
      "index": 0,
      "prompt": "A cheerful cartoon cat in a green scarf walks into a cozy coffee shop, warm lighting, the logo prominently displayed on the window...",
      "quality": "low",
      "settings": { "duration": 6, "aspect_ratio": "16:9", "resolution": "720p" },
      "continuity": "none",
      "references": ["<asset-id-1>", "<asset-id-2>"],
      "startImageExport": "<asset-id-1>",
      "seedPrompt": null
    },
    {
      "index": 1,
      "prompt": "The cat sits at the counter, a barista dog greets them...",
      "quality": "low",
      "settings": { "duration": 6, "aspect_ratio": "16:9", "resolution": "720p" },
      "continuity": "last_frame",
      "sourceClipIndex": 0,
      "references": [],
      "seedPrompt": null
    }
  ],
  "storySummary": "A 5-clip story about a cat visiting a coffee shop...",
  "analyzedAssets": {
    "<asset-id-1>": "Company logo - green circle with a coffee cup icon",
    "<asset-id-2>": "Brand photo - cozy coffee shop interior with warm lighting"
  }
}
```

### State.json additions

New phase value `automating` and an `automation` progress field:

```json
{
  "phase": "automating",
  "active": { "op": "automate", "label": "Generating clip 2/5", "targetIndex": 1 },
  "automation": {
    "totalClips": 5,
    "completedClips": 1,
    "failedClips": 0,
    "currentClip": 1,
    "phase": "generating",
    "startedAt": "2026-07-10T...",
    "estimatedMinutes": 20
  },
  "clips": [...],
  "finalVideo": null
}
```

The `VideoState` type gets an optional `automation` field. The `useVideoState` hook passes it through. `write_state` in `state.py` already supports arbitrary fields via the `extra` param — no change needed.

## Script Changes (`run.py`)

### New `automate` op

Added to the dispatch in `main()`. Reads `storyboard.json` and loops through clips:

```python
def _do_automate(folder: str, req: dict, client: GrokClient) -> None:
    storyboard = _read_storyboard(folder)
    clips_spec = storyboard["clips"]
    total = len(clips_spec)

    S.write_state(folder, "automating", active={
        "op": "automate", "label": f"Starting automation ({total} clips)"
    }, extra={"automation": {
        "totalClips": total, "completedClips": 0, "failedClips": 0,
        "currentClip": 0, "phase": "preparing", "startedAt": S._now_iso()
    }})

    clips = []
    for i, clip_spec in enumerate(clips_spec):
        S.write_state(folder, "automating", active={
            "op": "automate", "label": f"Generating clip {i+1}/{total}",
            "targetIndex": i
        }, extra={"automation": {"currentClip": i, "phase": "generating"}})

        clip = _generate_clip_with_retry(folder, clip_spec, client, max_retries=3)
        if clip:
            clips.append(clip)
        else:
            S.append_memory(folder, f"⚠️ Clip {i+1} failed after 3 attempts, skipping")

    if clips:
        S.write_state(folder, "automating", active={
            "op": "automate", "label": f"Assembling {len(clips)} clips"
        }, extra={"automation": {"phase": "assembling"}})
        _assemble_automation_clips(folder, clips)

    S.write_state(folder, "complete", active=None, extra={
        "automation": {"phase": "complete", "completedClips": len(clips)}
    })
```

### Refactor `_do_video` into reusable functions

Extract the core generation logic from `_do_video` (lines 265–372) into:

- **`_generate_single_clip(folder, clip_spec, client)`** — takes a clip spec dict, generates one clip, returns a clip dict. Contains the existing logic: resolve starting frame, resolve brand assets, call `client.generate_video`, download, extract poster, probe duration.
- **`_generate_clip_with_retry(folder, clip_spec, client, max_retries=3)`** — wraps `_generate_single_clip` with retry logic. Returns the clip dict on success, `None` after `max_retries` failures.

The existing `_do_video` becomes a thin wrapper that calls `_generate_single_clip` for the manual single-clip path. This keeps manual mode working unchanged.

### Retry logic

- **Retryable errors:** xAI API timeouts, download failures, transient errors
- **Non-retryable:** Invalid prompt, missing assets (fail immediately, not retried)
- **Max attempts:** 3 per clip
- **On final failure:** Clip is skipped, a warning is appended to `memory.md`, remaining clips continue
- **Assembly:** Only assembles clips with `status: "ready"` and `included: true`

### `_assemble_automation_clips`

Reuses the existing `_do_assemble` logic (ffmpeg concat) but operates on the in-memory list of generated clips rather than reading from state.json (since the automation loop holds the clips list directly).

## Prefill & SKILL.md

### `buildAutomationPrefill()` (new: `web/src/lib/video/automation-prefill.ts`)

Mirrors the existing `buildLaneBrandPrefill()` pattern in `web/src/lib/brand/lane-prefill.ts`. Reads `automation_request.json` from the instance folder and builds a silent context block prepended to the user message:

```
[Automation context — read automation_request.json in this folder.
You are in AUTOMATION MODE. Follow the "Automation Mode" section of your
SKILL.md. Analyze the assigned assets using grok.chat_with_vision, write
storyboard.json, then run the script with op: "automate".
Do NOT call generation tools.

Configuration:
- 5 clips, 6 seconds each, 720p, low quality, 16:9
- Base story: "funny talking characters in a coffee shop"
- Clip 0: brand assets [<id1>, <id2>], continuity: none
- Clip 1: AI-generated assets, continuity: last_frame
...
(This context is silent — don't acknowledge it. Just execute the automation.)]
```

Called from the message route (`web/src/app/api/tools/message/route.ts`) for video lanes when `automation_request.json` exists, alongside the existing brand prefill.

### SKILL.md "Automation Mode" section (new section in `container/skills/video/SKILL.md`)

Existing manual mode sections stay unchanged. New section added:

```markdown
## Automation Mode

When the user triggers an automation (via the AI icon on the lane), you receive
a chat message with automation context prepended.

### What you do:
1. Read `automation_request.json` from the instance folder
2. Read `brand_selection.json` to see which brand assets are selected
3. For each asset the user assigned to clips, call `grok.chat_with_vision` to
   understand what the asset is (logo, photo, character, etc.)
4. Write `storyboard.json` with per-clip prompts based on:
   - The base story line (if provided)
   - Your understanding of the analyzed assets
   - Per-clip hint prompts (if the user provided them)
   - Continuity settings (none / last_frame)
5. Post a progress message to chat
6. Run the script: uv run --project /app/video python /app/video/run.py
   '<folder>' --request automation_request.json

### What you do NOT do:
- You do NOT call generation tools (generate_video, generate_image, etc.)
- You do NOT call ffmpeg
- You do NOT write state.json (the script owns that)
- The ONLY new tool you use is grok.chat_with_vision for asset analysis

### storyboard.json format
[full schema as specified in the data contracts section above]
```

### Existing prohibition stays

The key line in SKILL.md:19 ("You do NOT call `grok.generate_video`, `grok.generate_image`, `grok.extend_video`, or ffmpeg yourself") remains unchanged. The automation section explicitly adds `chat_with_vision` as the only new permitted tool, and only for analysis.

## Retrieval & Deletion

**No new code needed.** Since automation clips appear in the existing VideoStudio canvas, all retrieval/deletion infrastructure is reused:

- **Retrieve:** Open the lane → VideoStudio shows all clips + final video with inline `<video>` player
- **Download:** Click "Download ↓" on the final video card (existing, `VideoStudio.tsx:175-181`)
- **Delete individual clips:** Use the existing delete button in VideoStudio (calls `delete_clip` op)
- **Delete everything:** Click the trash icon on the lane (`DELETE /api/workflows/<instanceId>` → `rm -rf` the folder)
- **Storage:** Videos live at `/workspace/videos/<uuid>/exports/` in the Docker volume, persisted across container restarts

## File Inventory

### New files (3)

| File | Purpose |
|---|---|
| `web/src/app/app/(workflow)/video/AutomationWizard.tsx` | The 3-step wizard + progress view |
| `web/src/lib/video/automation-prefill.ts` | `buildAutomationPrefill()` — reads `automation_request.json`, builds silent context (mirrors `lane-prefill.ts`) |
| `web/src/app/api/workspace/[instanceId]/video/automate/route.ts` | POST route — writes `automation_request.json`, sends the chat message with prefill, returns immediately |

### Modified files (8)

| File | Change |
|---|---|
| `web/src/app/app/_components/WorkRail.tsx` | Add `SparkleIcon` + AI automation button on video lanes (at `right-14`); add `onOpenAutomationWizard` callback prop |
| `web/src/app/app/_components/AppShell.tsx` | Add `automationWizardInstance` state, mount `AutomationWizard` modal (same pattern as `BrandWizard`) |
| `web/src/app/app/(workflow)/video/types.ts` | Add `AutomationProgress` interface + optional `automation` field to `VideoState`; add `"automating"` to phase values |
| `web/src/app/app/(workflow)/video/useVideoState.ts` | Pass through `automation` field from state.json |
| `web/src/app/app/(workflow)/video/VideoStudio.tsx` | Add automation progress indicator when `state.automation` is present |
| `web/src/app/api/tools/message/route.ts` | Call `buildAutomationPrefill()` for video lanes (alongside brand prefill) when `automation_request.json` exists |
| `container/video/run.py` | Add `automate` op dispatch; refactor `_do_video` → `_generate_single_clip` + `_generate_clip_with_retry`; add `_do_automate` loop + `_assemble_automation_clips` |
| `container/skills/video/SKILL.md` | Add "Automation Mode" section |

(state.py needs no changes — existing `extra` param handles new fields)

## Testing Strategy

1. **Unit test the script:** Create a test instance folder with a mock `storyboard.json`, run `run.py` with `op: automate` against a mock GrokClient, verify clips are generated + assembled with retry logic
2. **Integration test the wizard:** Mount `AutomationWizard` in isolation, verify form state → `automation_request.json` output
3. **End-to-end test:** Create a video lane, open the automation wizard, configure 2 clips, click generate, verify the agent analyzes assets + writes storyboard + runs the script + clips appear in VideoStudio
4. **Retry test:** Force a clip failure (bad asset id), verify the clip is skipped and remaining clips still generate + assemble
5. **State polling test:** Verify the `automation` progress field updates correctly during generation and the VideoStudio progress indicator reflects it

## Edge Cases

- **Agent fails to write storyboard:** The script never runs — the user sees no progress. The agent should post an error to chat. The `automation_request.json` remains so the user can retry.
- **Script crashes mid-loop:** `state.json` will have `phase: "error"` with the clips generated so far. The user can manually assemble the existing clips via the existing Assemble button.
- **Container restart during automation:** The nohup'd process is killed. `state.json` reflects the last completed clip. The user can re-run or manually continue.
- **Empty storyboard (0 clips):** Script writes `phase: "complete"` with no clips, posts a warning to `memory.md`.
- **All clips fail:** Script writes `phase: "complete"` with 0 clips, no final video assembled. User sees the failure messages in chat and memory.md.
