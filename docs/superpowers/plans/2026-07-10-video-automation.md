# Video Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AI-driven video automations — a sparkle icon on video lanes opens a wizard where the user configures the full video upfront (clips, durations, assets, story), then the agent analyzes assets with vision, writes a storyboard, and a deterministic script generates all clips with retry logic and assembles the final video.

**Architecture:** Hybrid model — the agent (DeepSeek + Grok vision MCP) analyzes brand/uploaded assets and writes `storyboard.json`; the deterministic Python script (`run.py`) reads the storyboard, generates each clip with 3-retry logic, and assembles the final video. Clips appear in the existing VideoStudio canvas for optional manual editing.

**Tech Stack:** Next.js 16 (App Router, React 19, TypeScript, Tailwind CSS 4), Python 3 (uv, xai-sdk, httpx), SQLite, Docker Compose, OpenCode agent runtime.

**Spec:** `docs/superpowers/specs/2026-07-10-video-automation-design.md`

---

## File Structure

### New files (3)

| File | Responsibility |
|---|---|
| `web/src/app/app/(workflow)/video/AutomationWizard.tsx` | 3-step wizard modal (Overview → Per-clip config → Review & Generate) + progress view. Shell-level overlay mounted like BrandWizard. |
| `web/src/lib/video/automation-prefill.ts` | `buildAutomationPrefill()` — reads `automation_request.json` from the container, builds a silent context block prepended to the agent chat message (mirrors `web/src/lib/brand/lane-prefill.ts`). |
| `web/src/app/api/workspace/[instanceId]/video/automate/route.ts` | POST route — validates input, writes `automation_request.json` to the instance folder via heredoc, sends the chat message to the agent via the existing `/api/tools/message` internal call, returns `{ ok: true }`. |

### Modified files (8)

| File | Change |
|---|---|
| `web/src/app/app/_components/WorkRail.tsx` | Add `SparkleIcon` SVG component; add automation button on video lanes at `right-14`; add `onOpenAutomationWizard` callback prop. |
| `web/src/app/app/_components/AppShell.tsx` | Add `automationWizardInstance` state; pass `onOpenAutomationWizard` to WorkRail; mount `AutomationWizard` modal (same pattern as BrandWizard). |
| `web/src/app/app/(workflow)/video/types.ts` | Add `AutomationProgress` interface; add `automation?: AutomationProgress \| null` field to `VideoState`. |
| `web/src/app/app/(workflow)/video/useVideoState.ts` | Add `parseAutomation()` helper; pass `automation` field through in the parse function. |
| `web/src/app/app/(workflow)/video/VideoStudio.tsx` | Add `AutomationProgressBar` component shown when `state.automation` is present and phase is `automating`. |
| `web/src/app/api/tools/message/route.ts` | For video lanes, call `buildAutomationPrefill()` when `automation_request.json` exists and prepend to the delivered message (alongside existing brand prefill). |
| `container/video/run.py` | Refactor `_do_video` → `_generate_single_clip()` + `_generate_clip_with_retry()`; add `_do_automate()` + `_assemble_automation_clips()` + `_read_storyboard()`; add `automate` to dispatch in `main()`. |
| `container/skills/video/SKILL.md` | Add "Automation Mode" section documenting the agent's workflow, storyboard.json format, and the `chat_with_vision` permission. |

---

## Task 1: Add SparkleIcon + automation button to WorkRail + wire AppShell

This task adds the visual entry point — a sparkle/AI icon on video lanes that opens the automation wizard. It follows the exact same pattern as the existing brand (paint) icon.

**Files:**
- Modify: `web/src/app/app/_components/WorkRail.tsx` (Props interface ~line 9, component signature ~line 36, lane button ~line 249, icon definitions ~line 406)
- Modify: `web/src/app/app/_components/AppShell.tsx` (imports ~line 8, state ~line 79, WorkRail props ~line 166, modal mount ~line 199)

- [ ] **Step 1: Add `onOpenAutomationWizard` to WorkRail Props**

In `web/src/app/app/_components/WorkRail.tsx`, add the new callback to the `Props` interface after `onOpenBrandWizard` (line 21):

```tsx
  /** Opens the per-lane automation wizard for an instance (video lanes only). */
  onOpenAutomationWizard: (inst: WorkflowInstance) => void;
```

- [ ] **Step 2: Add the prop to the component signature**

In the same file, update the `WorkRail` function signature (line 36) to destructure the new prop:

```tsx
export function WorkRail({ instances, activeId, activeLibrary, brandApplied, loading, onSelect, onSelectLibrary, onOpenBrandWizard, onOpenAutomationWizard, onRefresh }: Props) {
```

- [ ] **Step 3: Add the SparkleIcon component**

In the same file, add a new icon component after `BrandSwatchIcon` (after line 428):

```tsx
/** Sparkle icon for the per-lane automation button (video lanes only). */
function SparkleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" />
    </svg>
  );
}
```

- [ ] **Step 4: Add the automation button to the lane row**

In the same file, inside the `{!blocked && (...)}` block (line 249), add the automation button **before** the brand button. The automation button only appears on video lanes. Insert this right after the opening `<>` on line 250:

```tsx
                                {inst.workflow_type === "video" && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onOpenAutomationWizard(inst);
                                    }}
                                    title="Automate this lane"
                                    aria-label={`Automate ${inst.title}`}
                                    className="absolute right-14 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-[var(--muted)] opacity-100 transition hover:bg-indigo-500/15 hover:text-indigo-300"
                                  >
                                    <SparkleIcon />
                                  </button>
                                )}
```

- [ ] **Step 5: Wire AppShell state**

In `web/src/app/app/_components/AppShell.tsx`, add state for the automation wizard instance after the `brandWizardInstance` state (line 79):

```tsx
  const [automationWizardInstance, setAutomationWizardInstance] = useState<WorkflowInstance | null>(null);
```

- [ ] **Step 6: Pass the callback to WorkRail**

In the same file, add the `onOpenAutomationWizard` prop to the `<WorkRail>` component (after `onOpenBrandWizard`, ~line 173):

```tsx
          onOpenAutomationWizard={(inst) => setAutomationWizardInstance(inst)}
```

- [ ] **Step 7: Import and mount the AutomationWizard modal**

In the same file, add the import after the BrandWizard import (line 8):

```tsx
import { AutomationWizard } from "../(workflow)/video/AutomationWizard";
```

Then add the modal mount after the BrandWizard modal block (after line 207):

```tsx
        {automationWizardInstance && (
          <AutomationWizard
            instanceId={automationWizardInstance.id}
            onClose={() => setAutomationWizardInstance(null)}
          />
        )}
```

- [ ] **Step 8: Verify the build compiles (will fail — AutomationWizard doesn't exist yet)**

Run: `cd web && npx tsc --noEmit 2>&1 | head -20`
Expected: FAIL with "Cannot find module '../(workflow)/video/AutomationWizard'" — this is expected; Task 3 creates the component.

- [ ] **Step 9: Commit**

```bash
git add web/src/app/app/_components/WorkRail.tsx web/src/app/app/_components/AppShell.tsx
git commit -m "Add sparkle icon + automation button to video lanes

Wire the automation wizard trigger into WorkRail (video lanes only)
and AppShell (modal mount). The AutomationWizard component itself
is created in a follow-up task."
```

---

## Task 2: Add AutomationProgress type to video types + useVideoState passthrough

This task adds the TypeScript types for automation progress tracking and ensures the state polling passes the `automation` field through to the canvas.

**Files:**
- Modify: `web/src/app/app/(workflow)/video/types.ts` (end of file, ~line 118)
- Modify: `web/src/app/app/(workflow)/video/useVideoState.ts` (parse function ~line 23, new helper at end)

- [ ] **Step 1: Add AutomationProgress interface to types.ts**

In `web/src/app/app/(workflow)/video/types.ts`, add this interface before the `VideoState` interface (before line 104):

```ts
/** Progress tracking for an automation run. Written by the script's
 *  _do_automate op into state.json["automation"]. The canvas reads it
 *  to render a progress bar during long automation runs. */
export interface AutomationProgress {
  totalClips: number;
  completedClips: number;
  failedClips: number;
  currentClip: number;
  /** "preparing" | "generating" | "assembling" | "complete" */
  phase: string;
  startedAt: string;
  estimatedMinutes?: number;
}
```

- [ ] **Step 2: Add automation field to VideoState**

In the same file, add the `automation` field to the `VideoState` interface (after `finalVideo`, ~line 113):

```ts
  /** Present during an automation run (op: "automate"). */
  automation?: AutomationProgress | null;
```

- [ ] **Step 3: Add parseAutomation helper to useVideoState.ts**

In `web/src/app/app/(workflow)/video/useVideoState.ts`, add the import for `AutomationProgress`:

```ts
import type { AutomationProgress, ClipStatus, GeneratedImage, VideoClip, VideoState } from "./types";
```

Then add the `automation` field to the parse function's return object (after `finalVideo`, ~line 31):

```ts
      automation: parseAutomation(raw.automation),
```

Then add the `parseAutomation` helper function at the end of the file (after `asStringArray`):

```ts
function parseAutomation(raw: unknown): AutomationProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.totalClips !== "number") return null;
  return {
    totalClips: a.totalClips,
    completedClips: typeof a.completedClips === "number" ? a.completedClips : 0,
    failedClips: typeof a.failedClips === "number" ? a.failedClips : 0,
    currentClip: typeof a.currentClip === "number" ? a.currentClip : 0,
    phase: typeof a.phase === "string" ? a.phase : "preparing",
    startedAt: typeof a.startedAt === "string" ? a.startedAt : new Date().toISOString(),
    estimatedMinutes: typeof a.estimatedMinutes === "number" ? a.estimatedMinutes : undefined,
  };
}
```

- [ ] **Step 4: Verify the build compiles**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -v "AutomationWizard" | head -20`
Expected: PASS (no errors except the AutomationWizard import from Task 1)

- [ ] **Step 5: Commit**

```bash
git add web/src/app/app/\(workflow\)/video/types.ts web/src/app/app/\(workflow\)/video/useVideoState.ts
git commit -m "Add AutomationProgress type + state passthrough

Add the automation progress tracking type to VideoState and
parse it in useVideoState so the canvas can render a progress
bar during automation runs."
```

---

## Task 3: Create AutomationWizard component (3 steps + progress view)

This is the largest UI component. It's a 3-step wizard modal (matching BrandWizard's shell-level overlay pattern) that collects the automation configuration and submits it to the API route.

**Files:**
- Create: `web/src/app/app/(workflow)/video/AutomationWizard.tsx`

- [ ] **Step 1: Create the AutomationWizard component**

Create `web/src/app/app/(workflow)/video/AutomationWizard.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BrandKit, BrandAsset } from "@/lib/brand/types";
import type { Quality, Continuity } from "./types";
import { useBrandKit, useLaneBrandAssets, useUploads, uploadReference, fileUrl, estimateVideoCost } from "./lib";

interface Props {
  instanceId: string;
  onClose: () => void;
}

type Step = "overview" | "clips" | "review";
const STEP_ORDER: Step[] = ["overview", "clips", "review"];
const STEP_LABELS: Record<Step, string> = {
  overview: "Overview",
  clips: "Clips",
  review: "Review",
};

type AssetMode = "brand" | "ai" | "upload";

interface ClipConfig {
  continuity: Continuity;
  assetMode: AssetMode;
  brandAssets: string[];
  uploadedAssets: string[];
  promptHint: string;
}

function emptyClipConfig(index: number): ClipConfig {
  return {
    continuity: index === 0 ? "none" : "last_frame",
    assetMode: "brand",
    brandAssets: [],
    uploadedAssets: [],
    promptHint: "",
  };
}

/**
 * Automation wizard for video lanes. A 3-step modal that collects the full
 * video specification upfront (clip count, durations, resolution, per-clip
 * assets, base story), then submits it to the automate API route which writes
 * automation_request.json and triggers the agent.
 *
 * After submission, transitions to a progress view driven by state polling.
 * The user can close the wizard — the automation continues in the background
 * and clips appear in VideoStudio as they complete.
 */
export function AutomationWizard({ instanceId, onClose }: Props) {
  const [step, setStep] = useState<Step>("overview");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1: Overview settings
  const [clipCount, setClipCount] = useState(3);
  const [clipDuration, setClipDuration] = useState(6);
  const [resolution, setResolution] = useState("720p");
  const [quality, setQuality] = useState<Quality>("low");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [baseStory, setBaseStory] = useState("");

  // Step 2: Per-clip configs
  const [clipConfigs, setClipConfigs] = useState<ClipConfig[]>([]);

  // Brand kit + lane selection + uploads
  const { kit, loading: kitLoading } = useBrandKit();
  const { assets: laneAssets } = useLaneBrandAssets(instanceId, kit);
  const { uploads, refresh: refreshUploads } = useUploads(instanceId);

  // Sync clipConfigs array length with clipCount
  useEffect(() => {
    setClipConfigs((prev) => {
      const next = [...prev];
      while (next.length < clipCount) next.push(emptyClipConfig(next.length));
      while (next.length > clipCount) next.pop();
      return next;
    });
  }, [clipCount]);

  const patchClip = useCallback((index: number, patch: Partial<ClipConfig>) => {
    setClipConfigs((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    );
  }, []);

  const applyToAll = useCallback(() => {
    if (clipConfigs.length === 0) return;
    const template = clipConfigs[0];
    setClipConfigs((prev) =>
      prev.map((c, i) =>
        i === 0 ? c : { ...template, continuity: "last_frame" },
      ),
    );
  }, [clipConfigs]);

  async function handleGenerate() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspace/${instanceId}/video/automate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clipCount,
          clipDuration,
          resolution,
          quality,
          aspectRatio,
          baseStory,
          clips: clipConfigs.map((c, i) => ({
            index: i,
            continuity: c.continuity,
            assetMode: c.assetMode,
            brandAssets: c.brandAssets,
            uploadedAssets: c.uploadedAssets,
            promptHint: c.promptHint,
          })),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const stepIndex = STEP_ORDER.indexOf(step);
  const totalCost = useMemo(() => {
    return estimateVideoCost(quality, resolution, clipDuration, quality === "high");
  }, [quality, resolution, clipDuration]);
  const estMinutes = useMemo(() => {
    // Rough: ~1.5 min per clip for low, ~3 min for high
    const perClip = quality === "high" ? 3 : 1.5;
    return Math.ceil(clipCount * perClip);
  }, [clipCount, quality]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[var(--card)] shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3">
          <div className="flex items-center gap-2">
            <SparkleHeaderIcon />
            <h2 className="text-sm font-semibold text-[var(--foreground)]">Video Automation</h2>
          </div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-[var(--muted)] transition hover:bg-white/5 hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex shrink-0 items-center gap-1 border-b border-white/10 px-5 py-2">
          {STEP_ORDER.map((s, i) => (
            <button
              key={s}
              onClick={() => i < stepIndex + 1 && setStep(s)}
              disabled={i > stepIndex}
              className={
                "rounded-md px-2.5 py-1 text-[11px] font-medium transition " +
                (s === step
                  ? "bg-indigo-500/15 text-indigo-200"
                  : i < stepIndex
                    ? "text-[var(--muted)] hover:bg-white/5"
                    : "text-[var(--muted)]/40 cursor-not-allowed")
              }
            >
              {i + 1}. {STEP_LABELS[s]}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {step === "overview" && (
            <OverviewStep
              clipCount={clipCount}
              setClipCount={setClipCount}
              clipDuration={clipDuration}
              setClipDuration={setClipDuration}
              resolution={resolution}
              setResolution={setResolution}
              quality={quality}
              setQuality={setQuality}
              aspectRatio={aspectRatio}
              setAspectRatio={setAspectRatio}
              baseStory={baseStory}
              setBaseStory={setBaseStory}
              estMinutes={estMinutes}
              totalCost={totalCost}
            />
          )}
          {step === "clips" && (
            <ClipsStep
              clipConfigs={clipConfigs}
              patchClip={patchClip}
              applyToAll={applyToAll}
              laneAssets={laneAssets}
              uploads={uploads}
              instanceId={instanceId}
              onUploaded={refreshUploads}
              kitLoading={kitLoading}
            />
          )}
          {step === "review" && (
            <ReviewStep
              clipCount={clipCount}
              clipDuration={clipDuration}
              resolution={resolution}
              quality={quality}
              aspectRatio={aspectRatio}
              baseStory={baseStory}
              clipConfigs={clipConfigs}
              estMinutes={estMinutes}
              totalCost={totalCost}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between border-t border-white/10 px-5 py-3">
          <div className="flex gap-2">
            {stepIndex > 0 && (
              <button
                onClick={() => setStep(STEP_ORDER[stepIndex - 1])}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-[var(--muted)] transition hover:bg-white/5"
              >
                Back
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {error && <span className="text-[10px] text-red-300">{error}</span>}
            {stepIndex < STEP_ORDER.length - 1 ? (
              <button
                onClick={() => setStep(STEP_ORDER[stepIndex + 1])}
                className="rounded-lg bg-indigo-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-600"
              >
                Next
              </button>
            ) : (
              <button
                onClick={handleGenerate}
                disabled={submitting}
                className="rounded-lg bg-indigo-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-600 disabled:opacity-50"
              >
                {submitting ? "Starting…" : "Generate ✨"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Step components ─────────────────────────────────────────────────────────

function OverviewStep(props: {
  clipCount: number;
  setClipCount: (n: number) => void;
  clipDuration: number;
  setClipDuration: (n: number) => void;
  resolution: string;
  setResolution: (s: string) => void;
  quality: Quality;
  setQuality: (q: Quality) => void;
  aspectRatio: string;
  setAspectRatio: (s: string) => void;
  baseStory: string;
  setBaseStory: (s: string) => void;
  estMinutes: number;
  totalCost: string;
}) {
  const { clipCount, setClipCount, clipDuration, setClipDuration, resolution, setResolution,
    quality, setQuality, aspectRatio, setAspectRatio, baseStory, setBaseStory, estMinutes, totalCost } = props;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1 block text-[11px] font-medium text-[var(--foreground)]">
          Number of clips: <span className="text-indigo-300">{clipCount}</span>
        </label>
        <input type="range" min={1} max={10} value={clipCount}
          onChange={(e) => setClipCount(Number(e.target.value))}
          className="w-full accent-indigo-500" />
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-medium text-[var(--foreground)]">
          Duration per clip: <span className="text-indigo-300">{clipDuration}s</span>
        </label>
        <input type="range" min={1} max={15} value={clipDuration}
          onChange={(e) => setClipDuration(Number(e.target.value))}
          className="w-full accent-indigo-500" />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="mb-1 block text-[10px] uppercase tracking-wider text-[var(--muted)]">Resolution</label>
          <select value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-[var(--card)] px-2 py-1.5 text-xs text-[var(--foreground)]">
            <option value="480p">480p</option>
            <option value="720p">720p</option>
            {quality === "high" && <option value="1080p">1080p</option>}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[10px] uppercase tracking-wider text-[var(--muted)]">Quality</label>
          <select value={quality}
            onChange={(e) => setQuality(e.target.value as Quality)}
            className="w-full rounded-lg border border-white/10 bg-[var(--card)] px-2 py-1.5 text-xs text-[var(--foreground)]">
            <option value="low">Low (faster)</option>
            <option value="high">High (better)</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[10px] uppercase tracking-wider text-[var(--muted)]">Aspect</label>
          <select value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-[var(--card)] px-2 py-1.5 text-xs text-[var(--foreground)]">
            <option value="16:9">16:9 Landscape</option>
            <option value="9:16">9:16 Portrait</option>
            <option value="1:1">1:1 Square</option>
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-medium text-[var(--foreground)]">
          Base story (optional)
        </label>
        <textarea value={baseStory}
          onChange={(e) => setBaseStory(e.target.value)}
          placeholder="e.g. Funny talking characters in a coffee shop, or leave blank for AI to decide"
          rows={3}
          className="w-full rounded-lg border border-white/10 bg-[var(--card)] px-3 py-2 text-xs text-[var(--foreground)] placeholder:text-[var(--muted)]/50" />
        <p className="mt-1 text-[10px] text-[var(--muted)]">
          The AI will use this as a guide for the overall narrative. Each clip gets its own prompt based on this.
        </p>
      </div>

      <div className="rounded-lg border border-indigo-400/20 bg-indigo-500/[0.04] px-3 py-2 text-[11px] text-indigo-200/80">
        ⏱ Estimated time: ~{estMinutes} minutes · 💰 {totalCost} per clip
        <br />
        <span className="text-[10px] text-[var(--muted)]">
          You can close this wizard after starting — progress is saved and clips appear in the studio as they complete.
        </span>
      </div>
    </div>
  );
}

function ClipsStep(props: {
  clipConfigs: ClipConfig[];
  patchClip: (index: number, patch: Partial<ClipConfig>) => void;
  applyToAll: () => void;
  laneAssets: BrandAsset[];
  uploads: { path: string; filename: string }[];
  instanceId: string;
  onUploaded: () => void;
  kitLoading: boolean;
}) {
  const { clipConfigs, patchClip, applyToAll, laneAssets, uploads, instanceId, onUploaded, kitLoading } = props;

  if (kitLoading) {
    return <div className="py-8 text-center text-xs text-[var(--muted)]">Loading brand assets…</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-[var(--muted)]">
          Configure each clip. Brand assets come from this lane&apos;s Brand wizard. Uploads are one-time images for this video only.
        </p>
        <button onClick={applyToAll}
          className="shrink-0 rounded-lg border border-white/10 px-2 py-1 text-[10px] text-[var(--muted)] transition hover:bg-white/5">
          Apply clip 1 to all
        </button>
      </div>

      {clipConfigs.map((config, i) => (
        <ClipCard
          key={i}
          index={i}
          config={config}
          patch={(p) => patchClip(i, p)}
          laneAssets={laneAssets}
          uploads={uploads}
          instanceId={instanceId}
          onUploaded={onUploaded}
        />
      ))}
    </div>
  );
}

function ClipCard(props: {
  index: number;
  config: ClipConfig;
  patch: (p: Partial<ClipConfig>) => void;
  laneAssets: BrandAsset[];
  uploads: { path: string; filename: string }[];
  instanceId: string;
  onUploaded: () => void;
}) {
  const { index, config, patch, laneAssets, uploads, instanceId, onUploaded } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const selectedSet = new Set([...config.brandAssets, ...config.uploadedAssets]);

  const toggleAsset = (id: string) => {
    const isBrand = laneAssets.some((a) => a.id === id);
    if (isBrand) {
      const current = new Set(config.brandAssets);
      if (current.has(id)) current.delete(id);
      else current.add(id);
      patch({ brandAssets: [...current] });
    } else {
      const current = new Set(config.uploadedAssets);
      if (current.has(id)) current.delete(id);
      else current.add(id);
      patch({ uploadedAssets: [...current] });
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const result = await uploadReference(instanceId, file);
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    if (result) onUploaded();
  };

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-indigo-500/20 text-[10px] font-bold text-indigo-300">
          {index + 1}
        </span>
        <span className="text-xs font-medium text-[var(--foreground)]">Clip {index + 1}</span>
        <select
          value={config.continuity}
          onChange={(e) => patch({ continuity: e.target.value as Continuity })}
          className="ml-auto rounded-md border border-white/10 bg-[var(--card)] px-2 py-0.5 text-[10px] text-[var(--foreground)]"
        >
          <option value="none">New scene</option>
          {index > 0 && <option value="last_frame">Continue from last frame</option>}
        </select>
      </div>

      {/* Asset mode toggle */}
      <div className="mb-2 flex gap-1.5">
        {(["brand", "upload", "ai"] as AssetMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => patch({ assetMode: mode })}
            className={
              "rounded-md px-2 py-1 text-[10px] font-medium transition " +
              (config.assetMode === mode
                ? "bg-indigo-500/20 text-indigo-200"
                : "text-[var(--muted)] hover:bg-white/5")
            }
          >
            {mode === "brand" ? "Brand assets" : mode === "upload" ? "Uploads" : "AI creates"}
          </button>
        ))}
      </div>

      {/* Asset grid (brand + upload modes) */}
      {config.assetMode !== "ai" && (
        <div className="mb-2">
          {(laneAssets.length > 0 || uploads.length > 0) && (
            <div className="grid grid-cols-6 gap-1">
              {config.assetMode === "brand" && laneAssets.map((a) => {
                const checked = selectedSet.has(a.id);
                return (
                  <button key={a.id} type="button" onClick={() => toggleAsset(a.id)}
                    title={a.label}
                    className={
                      "relative aspect-square overflow-hidden rounded border transition " +
                      (checked ? "border-indigo-400 ring-1 ring-indigo-400/40" : "border-white/10 hover:border-white/30")
                    }>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/brand/assets/${encodeURIComponent(a.id)}`} alt={a.label}
                      className="h-full w-full object-contain" loading="lazy" />
                    {checked && (
                      <span className="absolute right-0.5 top-0.5 grid h-3 w-3 place-items-center rounded-full bg-indigo-500 text-[7px] text-white">✓</span>
                    )}
                  </button>
                );
              })}
              {config.assetMode === "upload" && (
                <>
                  {uploads.map((u) => {
                    const checked = selectedSet.has(u.path);
                    return (
                      <button key={u.path} type="button" onClick={() => toggleAsset(u.path)}
                        title={u.filename}
                        className={
                          "relative aspect-square overflow-hidden rounded border transition " +
                          (checked ? "border-indigo-400 ring-1 ring-indigo-400/40" : "border-white/10 hover:border-white/30")
                        }>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={fileUrl(instanceId, u.path)} alt={u.filename}
                          className="h-full w-full object-contain" loading="lazy" />
                        {checked && (
                          <span className="absolute right-0.5 top-0.5 grid h-3 w-3 place-items-center rounded-full bg-indigo-500 text-[7px] text-white">✓</span>
                        )}
                      </button>
                    );
                  })}
                  <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp"
                    onChange={handleUpload} className="hidden" />
                  <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
                    className="grid aspect-square place-items-center rounded border border-dashed border-white/15 text-[10px] text-[var(--muted)] transition hover:border-indigo-400/40 hover:text-indigo-300">
                    {uploading ? "…" : "+"}
                  </button>
                </>
              )}
            </div>
          )}
          {config.assetMode === "brand" && laneAssets.length === 0 && (
            <p className="text-[10px] text-[var(--muted)]">No brand assets selected for this lane. Use the Brand (🎨) icon to select assets first.</p>
          )}
          {config.assetMode === "upload" && uploads.length === 0 && (
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={handleUpload} className="hidden" />
          )}
          {config.assetMode === "upload" && uploads.length === 0 && (
            <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
              className="rounded-lg border border-dashed border-white/15 px-2 py-1.5 text-[10px] text-[var(--muted)] transition hover:border-indigo-400/40 hover:text-indigo-300">
              {uploading ? "Uploading…" : "+ Upload reference image"}
            </button>
          )}
        </div>
      )}

      {config.assetMode === "ai" && (
        <p className="mb-2 text-[10px] text-[var(--muted)]">
          The AI will create its own assets to fit the story line for this clip.
        </p>
      )}

      {/* Prompt hint */}
      <textarea
        value={config.promptHint}
        onChange={(e) => patch({ promptHint: e.target.value })}
        placeholder="Optional: describe what happens in this clip (overrides the base story for this clip)"
        rows={2}
        className="w-full rounded-md border border-white/10 bg-[var(--card)] px-2 py-1.5 text-[11px] text-[var(--foreground)] placeholder:text-[var(--muted)]/50"
      />
    </div>
  );
}

function ReviewStep(props: {
  clipCount: number;
  clipDuration: number;
  resolution: string;
  quality: Quality;
  aspectRatio: string;
  baseStory: string;
  clipConfigs: ClipConfig[];
  estMinutes: number;
  totalCost: string;
}) {
  const { clipCount, clipDuration, resolution, quality, aspectRatio, baseStory, clipConfigs, estMinutes, totalCost } = props;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
        <h3 className="mb-3 text-xs font-semibold text-[var(--foreground)]">Summary</h3>
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <SummaryRow label="Clips" value={`${clipCount}`} />
          <SummaryRow label="Duration each" value={`${clipDuration}s`} />
          <SummaryRow label="Total length" value={`${clipCount * clipDuration}s`} />
          <SummaryRow label="Resolution" value={resolution} />
          <SummaryRow label="Quality" value={quality} />
          <SummaryRow label="Aspect ratio" value={aspectRatio} />
          <SummaryRow label="Est. time" value={`~${estMinutes} min`} />
          <SummaryRow label="Cost per clip" value={totalCost} />
        </div>
        {baseStory && (
          <div className="mt-3 border-t border-white/5 pt-2">
            <p className="text-[10px] uppercase tracking-wider text-[var(--muted)]">Base story</p>
            <p className="mt-0.5 text-[11px] text-[var(--foreground)]">{baseStory}</p>
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold text-[var(--foreground)]">Clip breakdown</h3>
        <div className="flex flex-col gap-1.5">
          {clipConfigs.map((c, i) => (
            <div key={i} className="flex items-center gap-2 rounded-md border border-white/5 bg-white/[0.01] px-3 py-1.5 text-[10px]">
              <span className="font-medium text-indigo-300">Clip {i + 1}</span>
              <span className="text-[var(--muted)]">
                {c.continuity === "last_frame" ? "↻ continue" : "✦ new scene"}
              </span>
              <span className="text-[var(--muted)]">
                {c.assetMode === "ai" ? "AI-created assets" :
                  `${c.brandAssets.length + c.uploadedAssets.length} asset(s)`}
              </span>
              {c.promptHint && (
                <span className="truncate text-[var(--muted)]/70">"{c.promptHint}"</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-amber-400/20 bg-amber-500/[0.04] px-3 py-2 text-[11px] text-amber-200/80">
        ⚠ This process may take 10–30+ minutes depending on clip count and resolution.
        You can close this wizard — the automation runs in the background and clips appear in the studio as they complete.
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[var(--muted)]">{label}</span>
      <span className="font-medium text-[var(--foreground)]">{value}</span>
    </div>
  );
}

// ── Icons ───────────────────────────────────────────────────────────────────

function SparkleHeaderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-300" aria-hidden>
      <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
```

Note: The `ClipCard` component uses `useRef` and `useState` — make sure to add `useRef` to the imports at the top of the file if not already included. The import line should be:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd web && npx tsc --noEmit 2>&1 | head -20`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add web/src/app/app/\(workflow\)/video/AutomationWizard.tsx
git commit -m "Create AutomationWizard component

3-step wizard (Overview → Per-clip config → Review & Generate)
that collects the full video automation specification and submits
it to the automate API route. Includes brand asset selection,
one-time uploads, per-clip continuity, and prompt hints."
```

---

## Task 4: Create automate API route

This route writes `automation_request.json` to the instance folder and sends a chat message to the agent. It follows the pattern of the existing generate route but triggers the agent instead of launching the script directly.

**Files:**
- Create: `web/src/app/api/workspace/[instanceId]/video/automate/route.ts`

- [ ] **Step 1: Create the automate route**

Create `web/src/app/api/workspace/[instanceId]/video/automate/route.ts`:

```tsx
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { execInContainer, getContainerForUser } from "@/lib/docker";
import { promptAsync, getOrCreateSession, type SessionPrime } from "@/lib/opencode";
import { getWorkflow } from "@/lib/workflows/registry";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/workspace/<instanceId>/video/automate
 *
 * Writes automation_request.json into the instance folder, then sends a chat
 * message to the agent to trigger the automation workflow. The agent will:
 *   1. Read automation_request.json
 *   2. Analyze assigned assets using grok.chat_with_vision
 *   3. Write storyboard.json
 *   4. Run the deterministic script with op: "automate"
 *
 * The message route prepends buildAutomationPrefill() to the agent's message
 * (same pattern as brand prefill), so the agent gets full context.
 *
 * This route is fire-and-forget: it writes the request file, fires the chat
 * message, and returns { ok: true }. The agent processes asynchronously.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { instanceId } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  // ── Validate ────────────────────────────────────────────────────────────
  const clipCount = Math.min(10, Math.max(1, Number(body.clipCount) || 3));
  const clipDuration = Math.min(15, Math.max(1, Number(body.clipDuration) || 6));
  const resolution = ["480p", "720p", "1080p"].includes(body.resolution) ? body.resolution : "720p";
  const quality = body.quality === "high" ? "high" : "low";
  const aspectRatio = ["16:9", "9:16", "1:1"].includes(body.aspectRatio) ? body.aspectRatio : "16:9";
  const baseStory = typeof body.baseStory === "string" ? body.baseStory.slice(0, 2000) : "";
  const clips = Array.isArray(body.clips) ? body.clips : [];

  // Sanitize per-clip config
  const safeClips = clips.slice(0, clipCount).map((c: any, i: number) => ({
    index: i,
    continuity: c?.continuity === "last_frame" ? "last_frame" : "none",
    assetMode: ["brand", "ai", "upload"].includes(c?.assetMode) ? c.assetMode : "brand",
    brandAssets: Array.isArray(c?.brandAssets)
      ? c.brandAssets.filter((r: string) => typeof r === "string" && /^[a-zA-Z0-9_-]+$/.test(r))
      : [],
    uploadedAssets: Array.isArray(c?.uploadedAssets)
      ? c.uploadedAssets.filter((r: string) => /^uploads\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp|gif)$/i.test(r))
      : [],
    promptHint: typeof c?.promptHint === "string" ? c.promptHint.slice(0, 500) : "",
  }));

  // ── Resolve instance + container ────────────────────────────────────────
  const instance = db()
    .prepare(
      "SELECT id, user_id, workflow_type, folder FROM workflow_instances WHERE id = ? AND user_id = ?",
    )
    .get(instanceId, user.id) as
    | { id: string; user_id: number; workflow_type: string; folder: string }
    | undefined;
  if (!instance) {
    return NextResponse.json({ error: "workflow instance not found" }, { status: 404 });
  }
  if (instance.workflow_type !== "video") {
    return NextResponse.json(
      { error: `instance is not a video workflow (got ${instance.workflow_type})` },
      { status: 400 },
    );
  }

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return NextResponse.json({ error: "container not ready" }, { status: 409 });
  }

  // ── Write automation_request.json ───────────────────────────────────────
  const requestPayload = {
    op: "automate",
    clipCount,
    clipDuration,
    resolution,
    quality,
    aspectRatio,
    baseStory,
    clips: safeClips,
    folder: instance.folder,
    requestedAt: new Date().toISOString(),
  };
  const requestJson = JSON.stringify(requestPayload);
  const writeCmd = `cat > '${instance.folder}/automation_request.json' <<'__AUTOMATION_EOF__'\n${requestJson}\n__AUTOMATION_EOF__`;
  const writeRes = await execInContainer(row, ["bash", "-lc", writeCmd], { user: "appuser" });
  if (writeRes.code !== 0) {
    return NextResponse.json(
      { error: "failed to write automation_request.json", detail: writeRes.stderr.trim() || `exit ${writeRes.code}` },
      { status: 500 },
    );
  }

  // ── Send the chat message to trigger the agent ──────────────────────────
  // The message route will prepend buildAutomationPrefill() when it detects
  // automation_request.json in the folder. We send a simple visible message
  // that the user sees in the chat panel.
  const message = `Run video automation: ${clipCount} clips, ${clipDuration}s each, ${resolution} ${quality} quality, ${aspectRatio}.${baseStory ? ` Story: "${baseStory.slice(0, 100)}"` : ""} Read automation_request.json in this folder, analyze the assigned assets, write storyboard.json, then run the video script.`;

  // Fire the prompt to the agent's opencode session (fire-and-forget).
  // The session may already exist; getOrCreateSession handles priming.
  const def = getWorkflow("video");
  const prime: SessionPrime = {
    folder: instance.folder,
    skill: def?.skill ?? "video",
    sessionPrompt: def?.sessionPrompt,
  };

  try {
    const sessionId = await getOrCreateSession(row, instanceId, prime);
    await promptAsync(row, sessionId, message);
  } catch (e) {
    return NextResponse.json(
      { error: "failed to trigger agent", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd web && npx tsc --noEmit 2>&1 | head -20`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add web/src/app/api/workspace/\[instanceId\]/video/automate/route.ts
git commit -m "Create automate API route

POST /api/workspace/<id>/video/automate writes
automation_request.json and fires a chat message to the agent
to trigger the automation workflow (asset analysis → storyboard
→ script execution)."
```

---

## Task 5: Create buildAutomationPrefill() + wire into message route

This function builds the silent context block that tells the agent it's in automation mode. It mirrors `buildLaneBrandPrefill()` exactly in structure.

**Files:**
- Create: `web/src/lib/video/automation-prefill.ts`
- Modify: `web/src/app/api/tools/message/route.ts` (~line 127)

- [ ] **Step 1: Create automation-prefill.ts**

Create `web/src/lib/video/automation-prefill.ts`:

```tsx
import type { ContainerRow } from "@/lib/db";
import { readWorkspaceFileText } from "@/lib/docker";

const AUTOMATION_FILENAME = "automation_request.json";

/**
 * Builds a silent automation-context prefill for a video lane message, appended
 * server-side so the agent knows it's in AUTOMATION MODE. Never shown in the
 * chat bubbles (the message route filters user-message echoes).
 *
 * Reads the lane's automation_request.json (written by the automate route).
 * Returns an empty string when no automation request exists so non-automation
 * messages get no noise.
 *
 * @param instanceFolder  The lane's /workspace/videos/<id> folder
 */
export async function buildAutomationPrefill(
  row: ContainerRow,
  instanceFolder: string,
): Promise<string> {
  const text = await readWorkspaceFileText(row, `${instanceFolder}/${AUTOMATION_FILENAME}`);
  if (!text) return "";

  let req: Record<string, unknown>;
  try {
    req = JSON.parse(text);
  } catch {
    return "";
  }

  if (req.op !== "automate") return "";

  const lines: string[] = [
    `[Automation context — read automation_request.json in this folder.`,
    `You are in AUTOMATION MODE. Follow the "Automation Mode" section of your SKILL.md.`,
    `Analyze the assigned assets using grok.chat_with_vision, write storyboard.json,`,
    `then run the script with op: "automate". Do NOT call generation tools.]`,
    ``,
    `Configuration:`,
    `- ${req.clipCount} clips, ${req.clipDuration} seconds each, ${req.resolution} ${req.quality} quality, ${req.aspectRatio}`,
  ];

  if (req.baseStory) {
    lines.push(`- Base story: "${req.baseStory}"`);
  } else {
    lines.push(`- Base story: (none — create your own narrative)`);
  }

  const clips = req.clips as Array<Record<string, unknown>> | undefined;
  if (clips && Array.isArray(clips)) {
    for (const clip of clips) {
      const idx = clip.index;
      const continuity = clip.continuity === "last_frame" ? "continue from last frame" : "new scene";
      const mode = clip.assetMode;
      const brandAssets = (clip.brandAssets as string[]) ?? [];
      const uploadedAssets = (clip.uploadedAssets as string[]) ?? [];
      const hint = clip.promptHint ? ` hint: "${clip.promptHint}"` : "";

      let assetDesc: string;
      if (mode === "ai") {
        assetDesc = "AI-created assets (generate your own to fit the story)";
      } else {
        const parts: string[] = [];
        if (brandAssets.length > 0) parts.push(`brand [${brandAssets.join(", ")}]`);
        if (uploadedAssets.length > 0) parts.push(`uploads [${uploadedAssets.join(", ")}]`);
        assetDesc = parts.join(", ") || "none";
      }

      lines.push(`- Clip ${idx}: ${continuity}, ${assetDesc}${hint}`);
    }
  }

  lines.push(``);
  lines.push(`(This context is silent — don't acknowledge or repeat it. Just execute the automation.)`);

  return lines.join("\n");
}
```

- [ ] **Step 2: Wire into the message route**

In `web/src/app/api/tools/message/route.ts`, add the import after the brand prefill import (after line 19):

```tsx
import { buildAutomationPrefill } from "@/lib/video/automation-prefill";
```

Then, in the workflow lane path (after the brand prefill is built, ~line 128-129), add the automation prefill. Replace the existing brand prefill block:

```tsx
    const { buildLaneBrandPrefill } = await import("@/lib/brand/lane-prefill");
    const brandPrefill = await buildLaneBrandPrefill(row, instance.folder);
    if (brandPrefill) deliveredMessage = `${brandPrefill}\n\n${message}`;
```

With:

```tsx
    const { buildLaneBrandPrefill } = await import("@/lib/brand/lane-prefill");
    const brandPrefill = await buildLaneBrandPrefill(row, instance.folder);
    const automationPrefill = await buildAutomationPrefill(row, instance.folder);
    const prefills = [automationPrefill, brandPrefill].filter(Boolean).join("\n\n");
    if (prefills) deliveredMessage = `${prefills}\n\n${message}`;
```

- [ ] **Step 3: Verify the build compiles**

Run: `cd web && npx tsc --noEmit 2>&1 | head -20`
Expected: PASS (no errors)

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/video/automation-prefill.ts web/src/app/api/tools/message/route.ts
git commit -m "Add automation prefill + wire into message route

buildAutomationPrefill() reads automation_request.json and builds
a silent context block that tells the agent it's in automation
mode. Prepended to the agent's message alongside the brand prefill."
```

---

## Task 6: Refactor run.py _do_video → _generate_single_clip + _generate_clip_with_retry

This is the critical refactor that extracts the clip generation logic into a reusable function so the automation loop can call it. The existing `_do_video` becomes a thin wrapper.

**Files:**
- Modify: `container/video/run.py` (lines 265–372 for `_do_video`)

- [ ] **Step 1: Add _generate_single_clip function**

In `container/video/run.py`, add a new function `_generate_single_clip` **before** `_do_video` (before line 265). This function extracts the core logic from `_do_video` but takes a clip_spec dict instead of a raw request, and returns a clip dict instead of writing state:

```python
def _generate_single_clip(
    folder: str,
    clip_spec: dict,
    client: GrokClient,
    existing_clips: list[dict] | None = None,
) -> dict:
    """Generate a single video clip from a clip spec.

    This is the core generation logic, extracted from _do_video so the
    automation loop can call it repeatedly. Does NOT write state.json —
    the caller is responsible for state updates.

    Args:
        folder: Instance folder path.
        clip_spec: Dict with keys matching request.json for generate_video
            (prompt, quality, settings, references, continuity,
             sourceClipIndex, seedPrompt, startImageExport).
        client: GrokClient instance.
        existing_clips: Clips already in state (for last_frame continuity
            resolution). If None, reads from state.json.

    Returns:
        A clip dict (the same shape _do_video writes to clips[]).
    """
    settings = clip_spec.get("settings", {})
    quality = clip_spec.get("quality", "low")
    resolution = clamp_video_resolution(quality, settings.get("resolution", "720p"))
    duration = settings.get("duration")
    aspect = settings.get("aspect_ratio")
    prompt = clip_spec.get("prompt", "")

    state = S.read_state(folder)
    clips = existing_clips if existing_clips is not None else state.get("clips", [])
    new_index = S.next_clip_index(clips)
    num = S.clip_num(new_index)

    frame_path, extras = _resolve_starting_frame(folder, clip_spec, state, client, quality)

    # The xAI API does NOT allow both `image` and `reference_images` in the
    # same call. When both are present, merge the starting frame into refs.
    ref_ids = [r for r in clip_spec.get("references", []) if r != clip_spec.get("startImageExport")]
    user_refs = _resolve_brand_assets(folder, ref_ids)

    if frame_path and user_refs:
        all_refs = [frame_path] + user_refs
        result = client.generate_video(
            prompt=prompt, quality=quality, resolution=resolution,
            duration=duration, aspect_ratio=aspect,
            image_path=None, reference_paths=all_refs,
        )
    elif frame_path:
        result = client.generate_video(
            prompt=prompt, quality=quality, resolution=resolution,
            duration=duration, aspect_ratio=aspect,
            image_path=frame_path, reference_paths=None,
        )
    else:
        result = client.generate_video(
            prompt=prompt, quality=quality, resolution=resolution,
            duration=duration, aspect_ratio=aspect,
            image_path=None, reference_paths=user_refs if user_refs else None,
        )

    # Download + post-process
    local_mp4 = os.path.join("exports", f"clip-{num}.mp4")
    download(result.url, os.path.join(folder, local_mp4))

    poster_local: str | None = None
    try:
        poster_local = os.path.join("exports", f"clip-{num}.jpg")
        ff.extract_poster(os.path.join(folder, local_mp4), os.path.join(folder, poster_local))
    except Exception:
        poster_local = None

    duration_val = result.duration
    if duration_val is None:
        duration_val = ff.ffprobe_duration(os.path.join(folder, local_mp4))

    return {
        "index": new_index,
        "prompt": prompt,
        "sourceType": extras.get("sourceType", "text"),
        "quality": quality,
        "continuity": clip_spec.get("continuity", "none"),
        "seedFromClip": extras.get("seedFromClip"),
        "seedPrompt": extras.get("seedPrompt"),
        "seedImagePath": extras.get("seedImagePath"),
        "settings": settings,
        "references": clip_spec.get("references", []),
        "startImageExport": clip_spec.get("startImageExport"),
        "included": True,
        "status": "ready",
        "localPath": local_mp4,
        "posterPath": poster_local,
        "sourceUrl": result.url,
        "duration": duration_val,
    }
```

- [ ] **Step 2: Refactor _do_video into a thin wrapper**

Replace the existing `_do_video` function (lines 265–372) with a thin wrapper that calls `_generate_single_clip` and writes state:

```python
def _do_video(folder: str, req: dict, client: GrokClient) -> None:
    """Generate a single video clip (manual mode). Wraps _generate_single_clip
    with state management so the canvas sees progress."""
    new_index = S.next_clip_index(S.read_state(folder).get("clips", []))
    _set_active(folder, "generate_video", f"Generating clip {new_index + 1}", target_index=new_index)
    S.write_state(folder, "generating", active={"op": "generate_video", "label": f"Generating clip {new_index + 1}", "targetIndex": new_index})

    clip = _generate_single_clip(folder, req, client)

    state = S.read_state(folder)
    clips = state.get("clips", [])
    clips.append(clip)
    S.write_state(folder, "complete", clips=clips, active=None, mode="video")
    S.append_memory(
        folder,
        f"🎬 Generated clip {new_index + 1} ({clip.get('sourceType', 'text')}, {clip.get('quality')}). "
        f"Prompt: {clip.get('prompt', '')[:80]}",
    )
```

Note: `_resolve_starting_frame` calls `S.write_state` internally (for the seed frame phase). This is fine — the state writes are idempotent and the caller's final `write_state` with `clips=clips` overwrites the phase.

- [ ] **Step 3: Add _generate_clip_with_retry function**

Add this function after `_generate_single_clip`:

```python
def _generate_clip_with_retry(
    folder: str,
    clip_spec: dict,
    client: GrokClient,
    max_retries: int = 3,
    existing_clips: list[dict] | None = None,
) -> dict | None:
    """Generate a single clip with retry logic.

    Returns the clip dict on success, or None after max_retries failures.
    Non-retryable errors (invalid prompt, missing assets) fail immediately.
    """
    last_error: Exception | None = None
    for attempt in range(1, max_retries + 1):
        try:
            return _generate_single_clip(folder, clip_spec, client, existing_clips)
        except Exception as e:
            last_error = e
            err_str = str(e).lower()
            # Non-retryable: these won't get better with retries.
            if any(kw in err_str for kw in ["invalid", "unauthorized", "forbidden", "not found"]):
                S.append_memory(folder, f"❌ Clip {clip_spec.get('index', '?')+1} failed (non-retryable): {e}")
                return None
            if attempt < max_retries:
                S.append_memory(folder, f"↻ Clip {clip_spec.get('index', '?')+1} attempt {attempt}/{max_retries} failed: {e}, retrying...")
            else:
                S.append_memory(folder, f"⚠️ Clip {clip_spec.get('index', '?')+1} failed after {max_retries} attempts: {e}")
    return None
```

- [ ] **Step 4: Verify the script still parses**

Run: `cd container/video && python3 -c "import ast; ast.parse(open('run.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add container/video/run.py
git commit -m "Refactor _do_video into _generate_single_clip + retry wrapper

Extract core clip generation logic into _generate_single_clip (returns
clip dict, no state writes) and add _generate_clip_with_retry (3 attempts,
skip non-retryable errors). _do_video becomes a thin wrapper. This
enables the automation loop to generate clips without duplicating logic."
```

---

## Task 7: Add _do_automate + _assemble_automation_clips to run.py

This adds the new `automate` op that reads `storyboard.json`, loops through clips with retry, and assembles the final video.

**Files:**
- Modify: `container/video/run.py` (add functions before `main()`, add dispatch in `main()`)

- [ ] **Step 1: Add _read_storyboard helper**

In `container/video/run.py`, add this helper after `_read_request` (~line 55):

```python
def _read_storyboard(folder: str) -> dict:
    """Read storyboard.json from the instance folder."""
    path = os.path.join(folder, "storyboard.json")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
```

- [ ] **Step 2: Add _do_automate function**

In `container/video/run.py`, add this function before the `# ── Main ──` section (before line 524):

```python
# ── Automate ───────────────────────────────────────────────────────────────


def _do_automate(folder: str, req: dict, client: GrokClient) -> None:
    """Run a full video automation: read storyboard.json, generate all clips
    with retry logic, skip failures, and assemble the final video.

    The agent writes storyboard.json after analyzing assets with vision.
    This function reads it and executes the generation deterministically.
    """
    storyboard = _read_storyboard(folder)
    clips_spec = storyboard.get("clips", [])
    total = len(clips_spec)

    if total == 0:
        S.write_state(folder, "complete", active=None, extra={"automation": {
            "totalClips": 0, "completedClips": 0, "failedClips": 0,
            "currentClip": 0, "phase": "complete", "startedAt": S._now_iso(),
        }})
        S.append_memory(folder, "⚠️ Automation completed with 0 clips (empty storyboard).")
        return

    S.write_state(folder, "automating", active={
        "op": "automate", "label": f"Starting automation ({total} clips)"
    }, extra={"automation": {
        "totalClips": total, "completedClips": 0, "failedClips": 0,
        "currentClip": 0, "phase": "preparing", "startedAt": S._now_iso(),
    }})
    S.append_memory(folder, f"🤖 Starting automation: {total} clips.")

    generated_clips: list[dict] = []
    failed = 0

    for i, clip_spec in enumerate(clips_spec):
        # Update progress before each clip
        S.write_state(folder, "automating", active={
            "op": "automate",
            "label": f"Generating clip {i + 1}/{total}",
            "targetIndex": i,
        }, extra={"automation": {
            "totalClips": total,
            "completedClips": len(generated_clips),
            "failedClips": failed,
            "currentClip": i,
            "phase": "generating",
            "startedAt": S._now_iso(),
        }})

        # Generate with retry. Pass existing clips so last_frame continuity
        # can resolve the previous clip's path.
        clip = _generate_clip_with_retry(
            folder, clip_spec, client, max_retries=3,
            existing_clips=generated_clips,
        )

        if clip:
            generated_clips.append(clip)
            # Write incremental state so the canvas shows clips as they complete
            S.write_state(folder, "automating", clips=generated_clips, active={
                "op": "automate",
                "label": f"Generated clip {i + 1}/{total}",
                "targetIndex": i,
            }, extra={"automation": {
                "totalClips": total,
                "completedClips": len(generated_clips),
                "failedClips": failed,
                "currentClip": i,
                "phase": "generating",
                "startedAt": S._now_iso(),
            }})
        else:
            failed += 1

    # Assemble successful clips
    if generated_clips:
        S.write_state(folder, "automating", active={
            "op": "automate", "label": f"Assembling {len(generated_clips)} clips"
        }, extra={"automation": {
            "totalClips": total,
            "completedClips": len(generated_clips),
            "failedClips": failed,
            "currentClip": total - 1,
            "phase": "assembling",
            "startedAt": S._now_iso(),
        }})

        _assemble_automation_clips(folder, generated_clips)
    else:
        S.append_memory(folder, "⚠️ No clips generated successfully — skipping assembly.")

    # Final state
    S.write_state(folder, "complete", clips=generated_clips, active=None, extra={"automation": {
        "totalClips": total,
        "completedClips": len(generated_clips),
        "failedClips": failed,
        "currentClip": total - 1 if total > 0 else 0,
        "phase": "complete",
        "startedAt": S._now_iso(),
    }})

    summary = storyboard.get("storySummary", "(no summary)")
    S.append_memory(
        folder,
        f"📦 Automation complete: {len(generated_clips)}/{total} clips generated, "
        f"{failed} failed. Story: {summary[:100]}",
    )
```

- [ ] **Step 3: Add _assemble_automation_clips function**

Add this function after `_do_automate`:

```python
def _assemble_automation_clips(folder: str, clips: list[dict]) -> None:
    """Assemble generated clips into exports/final.mp4.

    Reuses the ffmpeg concat logic from _do_assemble but operates on an
    in-memory clips list (the automation loop holds the clips directly,
    rather than reading from state.json).
    """
    paths: list[str] = []
    for c in clips:
        if c.get("localPath") and os.path.exists(os.path.join(folder, c["localPath"])):
            paths.append(os.path.join(folder, c["localPath"]))

    if not paths:
        S.append_memory(folder, "⚠️ Assembly skipped: no rendered clips found.")
        return

    final_local = os.path.join("exports", "final.mp4")
    ff.concat_clips(paths, os.path.join(folder, final_local))
    duration_val = ff.ffprobe_duration(os.path.join(folder, final_local))

    clip_indices = [c["index"] for c in clips]
    final_video = {
        "localPath": final_local,
        "duration": duration_val,
        "clipCount": len(paths),
        "clipIndices": clip_indices,
        "builtAt": S._now_iso(),
    }
    S.write_state(folder, "complete", final_video=final_video, clips=clips, active=None)
    S.append_memory(folder, f"📦 Assembled final video from {len(paths)} clip(s).")
```

- [ ] **Step 4: Add automate to the dispatch in main()**

In the `main()` function (around line 576), add `automate` to the provider-dependent ops. After the `elif op == "extend_video":` block, add:

```python
        elif op == "automate":
            _do_automate(folder, req, client)
```

So the full dispatch block looks like:

```python
        if op == "generate_image":
            _do_image(folder, req, client, edit=False)
        elif op == "edit_image":
            _do_image(folder, req, client, edit=True)
        elif op == "generate_video":
            _do_video(folder, req, client)
        elif op == "extend_video":
            _do_extend(folder, req, client)
        elif op == "automate":
            _do_automate(folder, req, client)
        else:
            _fail(folder, f"unknown op: {op}")
            return 1
```

- [ ] **Step 5: Verify the script parses**

Run: `cd container/video && python3 -c "import ast; ast.parse(open('run.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add container/video/run.py
git commit -m "Add automate op to video pipeline

_do_automate reads storyboard.json, loops through clips with retry
logic (skip failures), writes incremental progress to state.json, and
assembles the final video. _assemble_automation_clips reuses ffmpeg
concat on the in-memory clips list."
```

---

## Task 8: Add Automation Mode section to SKILL.md

This tells the agent how to handle automation requests — analyze assets with vision, write the storyboard, run the script.

**Files:**
- Modify: `container/skills/video/SKILL.md` (add section at the end, before the Resume section)

- [ ] **Step 1: Add the Automation Mode section**

In `container/skills/video/SKILL.md`, add this section **before** the `## Resume` section (before line 147):

```markdown
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

### Story writing guidelines

- If the user provided a base story, build per-clip prompts that advance that narrative across the clips.
- If no base story was provided, create your own narrative based on the analyzed assets.
- For clips with `assetMode: "ai"`, don't assign brand assets — let the script generate seed frames from your prompt.
- For clips with `continuity: "last_frame"`, set `sourceClipIndex` to the previous clip's index.
- Make each clip's prompt detailed and visual — describe the scene, action, lighting, and mood.
```

- [ ] **Step 2: Commit**

```bash
git add container/skills/video/SKILL.md
git commit -m "Add Automation Mode section to video SKILL.md

Documents the agent's automation workflow: analyze assets with
grok.chat_with_vision, write storyboard.json, run the script.
The existing prohibition on generation tools remains unchanged."
```

---

## Task 9: Add automation progress indicator to VideoStudio

This adds a progress bar to the VideoStudio canvas that shows during automation runs, using the `automation` field from state.json.

**Files:**
- Modify: `web/src/app/app/(workflow)/video/VideoStudio.tsx` (add component + render it)

- [ ] **Step 1: Add the AutomationProgressBar component and render it**

In `web/src/app/app/(workflow)/video/VideoStudio.tsx`, add the import for `AutomationProgress` type at the top (add to the existing types import):

```tsx
import type { AutomationProgress, VideoClip } from "./types";
```

Then add the `AutomationProgressBar` component before the `VideoStudio` component (or at the end of the file):

```tsx
function AutomationProgressBar({ automation }: { automation: AutomationProgress }) {
  const { totalClips, completedClips, failedClips, currentClip, phase } = automation;
  const progress = totalClips > 0 ? ((completedClips + failedClips) / totalClips) * 100 : 0;

  const phaseLabel = phase === "preparing"
    ? "Preparing…"
    : phase === "generating"
      ? `Generating clip ${currentClip + 1}/${totalClips}`
      : phase === "assembling"
        ? "Assembling final video…"
        : "Complete";

  return (
    <div className="shrink-0 border-b border-indigo-400/20 bg-indigo-500/[0.04] px-4 py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="animate-pulse text-indigo-300" aria-hidden>
          <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" />
        </svg>
        <span className="text-xs font-semibold text-indigo-200">Automation</span>
        <span className="text-[11px] text-[var(--muted)]">{phaseLabel}</span>
        {failedClips > 0 && (
          <span className="text-[10px] text-amber-300">{failedClips} skipped</span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-indigo-400 transition-all duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
```

Then, in the `VideoStudio` component's return JSX, add the progress bar after the error banner and before `FinalVideoCard`. Find the `{visibleErrors.length === 0 ? null : (...)}` block and add after it:

```tsx
      {state?.automation && state.automation.phase !== "complete" && (
        <AutomationProgressBar automation={state.automation} />
      )}
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd web && npx tsc --noEmit 2>&1 | head -20`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add web/src/app/app/\(workflow\)/video/VideoStudio.tsx
git commit -m "Add automation progress bar to VideoStudio

Shows a live progress bar with phase indicator and clip count
during automation runs. Driven by the automation field in
state.json, polled every 2.5s."
```

---

## Final Verification

- [ ] **Step 1: Full TypeScript build check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 2: Python syntax check**

Run: `cd container/video && python3 -c "import ast; ast.parse(open('run.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Verify the app starts**

Run: `cd web && npm run build`
Expected: Build completes successfully

- [ ] **Step 4: Final commit (if any cleanup needed)**

If any fixes were needed during verification, commit them:
```bash
git add -A && git commit -m "Fix build issues from final verification"
```
