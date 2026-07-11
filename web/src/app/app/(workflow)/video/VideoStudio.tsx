"use client";

import { useMemo, useState } from "react";
import type { CanvasProps } from "@/lib/workflows/types";
import { useAgentChatContext } from "@/lib/hooks/AgentChatContext";
import { postGenerate, useBrandKit, useLaneBrandAssets, useUploads } from "./lib";
import { ClipFilmstrip } from "./ClipFilmstrip";
import { ClipPlayer } from "./ClipPlayer";
import { FinalVideoCard } from "./FinalVideoCard";
import { GeneratePanel } from "./GeneratePanel";
import { VideoToolbar } from "./VideoToolbar";
import type { AutomationProgress, VideoClip, VideoState } from "./types";

/**
 * The Video Studio canvas — a storyboard of independent video clips that can be
 * generated, edited, and assembled into one final video. Registered in
 * WORKFLOW_REGISTRY as type "video".
 *
 * Layout mirrors Carousel Studio: a toolbar, a big preview pane, a right-side
 * generate panel, and a filmstrip. All views are read-only except the generate
 * form (which POSTs to the deterministic script via the generate route) and
 * NL edits (which flow through the agent panel). The shell passes polled state
 * in as props; this component owns only the `selected clip` UI state.
 */
export function VideoStudio({ instanceId, state }: CanvasProps<VideoState>) {
  const chat = useAgentChatContext();
  const { kit } = useBrandKit();
  const { assets: laneAssets } = useLaneBrandAssets(instanceId, kit);
  // Construct a kit with only the assets selected for this lane (via the Brand
  // wizard). The ReferenceGrid reads kit.assets — so passing a filtered set
  // ensures only wizard-selected assets appear, not the entire brand kit.
  const laneKit = kit ? { ...kit, assets: laneAssets } : null;
  const { uploads, refresh: refreshUploads } = useUploads(instanceId);
  const [selected, setSelected] = useState<number | null>(null);
  const [dismissedErrors, setDismissedErrors] = useState<string[]>([]);
  // Local "submitting" flag — set immediately on form submit so the UI (and the
  // chat panel via the generation-busy context) reflects the in-flight state
  // before the first state.json poll catches up.
  const [localBusy, setLocalBusy] = useState(false);

  const clips = useMemo(() => state?.clips ?? [], [state?.clips]);
  const images = useMemo(() => state?.images ?? [], [state?.images]);
  const phase = state?.phase ?? "unknown";
  const version = state?.lastUpdated;
  const active = state?.active ?? null;
  // busy is true if ANY of: the script is generating, we just submitted (and
  // the phase hasn't caught up), or the agent chat is mid-response. This makes
  // the disable symmetric — chat disables during script runs, and the form
  // disables during chat — preventing either from interfering with the other.
  const scriptBusy = isGenerating(phase);
  if (localBusy && (scriptBusy || phase === "complete" || phase.startsWith("error"))) {
    setLocalBusy(false);
  }
  const busy = localBusy || scriptBusy || chat.busy;
  const inFlightIndex = active?.targetIndex ?? null;

  // Derive the effective selection during render (React "adjust state during
  // render" pattern). Fall back to the first clip if none selected/exists.
  const exists = selected !== null && clips.some((c) => c.index === selected);
  const effectiveSelected = clips.length === 0 ? null : exists ? selected : clips[0].index;
  if (effectiveSelected !== selected) {
    setSelected(effectiveSelected);
  }

  const selectedClip = clips.find((c) => c.index === effectiveSelected) ?? null;
  const includedClips = clips.filter((c) => c.included);
  const assembling = active?.op === "assemble";

  // ── Actions: all go through the direct generate route (fire-and-forget),
  //    never through the agent chat. This keeps them reliable and independent
  //    of the chat session. ────────────────────────────────────────────────

  const handleToggleInclude = (index: number) => {
    const clip = clips.find((c) => c.index === index);
    if (!clip) return;
    postGenerate(instanceId, {
      op: "toggle_include",
      prompt: "",
      quality: "low",
      settings: { quality: "low" },
      references: [],
      sourceClipIndex: index,
      included: !clip.included,
    });
  };

  const handleAssemble = () => {
    if (includedClips.length === 0 || busy) return;
    setLocalBusy(true);
    const indices = includedClips.map((c) => c.index);
    postGenerate(instanceId, {
      op: "assemble",
      prompt: "",
      quality: "low",
      settings: { quality: "low" },
      references: [],
      clipIndices: indices,
    });
  };

  const handleRegenerate = () => {
    if (!selectedClip || busy) return;
    setLocalBusy(true);
    postGenerate(instanceId, {
      op: "generate_video",
      prompt: selectedClip.prompt,
      quality: selectedClip.quality,
      settings: selectedClip.settings,
      references: selectedClip.references,
      continuity: selectedClip.continuity,
      sourceClipIndex: selectedClip.seedFromClip,
      startImageExport: selectedClip.startImageExport,
    });
  };

  const handleDelete = () => {
    if (!selectedClip || busy) return;
    const idx = selectedClip.index;
    setSelected(null);
    postGenerate(instanceId, {
      op: "delete_clip",
      prompt: "",
      quality: "low",
      settings: { quality: "low" },
      references: [],
      sourceClipIndex: idx,
    });
  };

  // Called by GeneratePanel when a form submit succeeds — sets localBusy so
  // the chat disables immediately.
  const handleSubmitStarted = () => setLocalBusy(true);

  return (
    <div className="flex h-full flex-col">
      <VideoToolbar
        selectedClip={selectedClip}
        busy={busy}
        onRegenerate={handleRegenerate}
      />

      {(() => {
        const rawErrors = state?.errors ?? [];
        // Show only errors the user hasn't dismissed. When the error set changes
        // (new generation), dismissed ones that are no longer present naturally
        // clear; we filter by the current error strings.
        const visibleErrors = rawErrors.filter((e) => !dismissedErrors.includes(e));
        if (visibleErrors.length === 0) return null;
        return (
          <div className="flex shrink-0 items-center gap-2 border-b border-red-400/20 bg-red-500/10 px-4 py-2 text-xs text-red-300">
            <span className="flex-1">{visibleErrors.join("; ")}</span>
            <button
              type="button"
              onClick={() => setDismissedErrors(rawErrors)}
              className="shrink-0 text-red-300/60 transition hover:text-red-200"
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        );
      })()}

      {phase === "starting" && (
        <div className="shrink-0 border-b border-indigo-400/20 bg-indigo-500/[0.04] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="animate-pulse text-indigo-300" aria-hidden>
              <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" />
            </svg>
            <span className="text-xs font-semibold text-indigo-200">
              {active?.label || "Starting…"}
            </span>
          </div>
        </div>
      )}

      {state?.automation && state.automation.phase !== "complete" && (
        <AutomationProgressBar automation={state.automation} />
      )}

      <FinalVideoCard
        assembling={assembling}
        onAssemble={handleAssemble}
        includedCount={includedClips.length}
      />

      {state?.finalVideo?.localPath && (
        <div className="shrink-0 border-b border-emerald-400/20 bg-emerald-500/[0.04] px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500 text-[10px] text-white">✓</span>
            <span className="text-xs font-semibold text-emerald-300">Final Video</span>
            <span className="text-[10px] text-[var(--muted)]">
              {state.finalVideo.clipCount} clip{state.finalVideo.clipCount === 1 ? "" : "s"}
              {state.finalVideo.duration ? ` · ${state.finalVideo.duration.toFixed(1)}s` : ""}
              {" · "}built {new Date(state.finalVideo.builtAt).toLocaleTimeString()}
            </span>
            <a
              href={`/api/workspace/${instanceId}/file/${state.finalVideo.localPath}${version ? `?v=${version}` : ""}`}
              download
              className="ml-auto rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] font-semibold text-[var(--foreground)] transition hover:bg-white/[0.06]"
            >
              Download ↓
            </a>
          </div>
          <video
            key={state.finalVideo.localPath + (version ?? "")}
            controls
            className="max-h-28 w-full rounded-lg border border-emerald-400/15"
          >
            <source
              src={`/api/workspace/${instanceId}/file/${state.finalVideo.localPath}${version ? `?v=${version}` : ""}`}
              type="video/mp4"
            />
          </video>
        </div>
      )}

      {/* Preview + generate panel */}
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_320px]">
        <div className="min-h-0 min-w-0 p-4">
          <ClipPlayer
            instanceId={instanceId}
            clip={selectedClip}
            version={version}
            onToggleInclude={handleToggleInclude}
          />
        </div>
        <GeneratePanel
          instanceId={instanceId}
          kit={laneKit}
          version={version}
          clips={clips}
          images={images}
          uploads={uploads}
          selectedClipIndex={effectiveSelected}
          busy={busy}
          onUploaded={refreshUploads}
          onSubmitted={handleSubmitStarted}
        />
      </div>

      {/* Filmstrip */}
      <div className="shrink-0 border-t border-white/10 bg-[var(--card)]/20">
        <ClipFilmstrip
          instanceId={instanceId}
          clips={clips}
          selectedIndex={selected}
          inFlightIndex={inFlightIndex}
          onSelect={setSelected}
          onToggleInclude={handleToggleInclude}
          onDelete={handleDelete}
          version={version}
        />
      </div>
    </div>
  );
}

/** True when the deterministic script is mid-generation (phases other than idle/complete/error). */
function isGenerating(phase: string): boolean {
  return (
    phase !== "complete" &&
    phase !== "idle" &&
    phase !== "unknown" &&
    phase !== "—" &&
    !phase.startsWith("error")
  );
}
// Note: "automating" phase also returns true here, which is correct —
// the automation run should disable the generate panel just like manual generation.

// Re-export the clip type for convenience (used by sub-components importing from here).
export type { VideoClip };

/** Progress bar shown during automation runs (op: "automate"). Driven by the
 *  `automation` field in state.json, polled every 2.5s. Shows phase, clip
 *  progress, and failed clip count. */
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
