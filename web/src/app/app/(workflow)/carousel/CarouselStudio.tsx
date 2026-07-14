"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasProps } from "@/lib/workflows/types";
import { useCanvaStatus } from "@/app/app/_components/CanvaStatusProvider";
import { CandidateStrip } from "./CandidateStrip";
import { Filmstrip } from "./Filmstrip";
import { SlideCopyPanel } from "./SlideCopyPanel";
import { SlidePreview } from "./SlidePreview";
import { StudioToolbar } from "./StudioToolbar";
import type { CarouselState } from "./types";

/**
 * The Carousel Studio canvas — the first real workflow (spec §2). Registered in
 * WORKFLOW_REGISTRY. Composes the toolbar, big slide preview, read-only copy
 * panel, filmstrip, and design card. All views are read-only; edits go through
 * the agent (the toolbar's buttons post templated chat messages).
 *
 * The shell calls `useCarouselState` and passes the polled state in as props
 * per the CanvasProps contract (spec §3.2) — this component is purely
 * presentational and owns only the `selected slide` UI state.
 */
export function CarouselStudio({ instanceId, state }: CanvasProps<CarouselState>) {
  // Poll state is owned by the shell; this component only tracks which slide
  // the user has selected in the filmstrip.
  const [selected, setSelected] = useState<number | null>(null);
  const [dismissedErrors, setDismissedErrors] = useState<string[]>([]);
  const { invalidateCanva } = useCanvaStatus();

  // When state.errors contains a Canva 401 / invalid-token message, force the
  // Canva status to disconnected so the header shows "Connect Canva" and the
  // WorkRail disables Carousel lanes.
  const handled401Ref = useRef(false);
  useEffect(() => {
    if (!state?.errors?.length) {
      handled401Ref.current = false;
      return;
    }
    if (handled401Ref.current) return;
    const has401 = state.errors.some((e) => /401|invalid_token|expired/i.test(e));
    if (has401) {
      handled401Ref.current = true;
      invalidateCanva();
    }
  }, [state?.errors, invalidateCanva]);

  const slides = useMemo(() => state?.slides ?? [], [state?.slides]);
  const phase = state?.phase ?? "unknown";
  const version = state?.lastUpdated;  // cache-buster: edits bump lastUpdated → images re-fetch
  const hasExports = (state?.exports?.length ?? 0) > 0;
  // A design exists if the collection-level link is set (deck mode, or posts
  // mode's slide-0 default) OR any slide carries its own design_id/canva_url
  // (posts mode: each slide is its own Canva design).
  const hasDesign =
    Boolean(state?.design?.design_id || state?.design?.canva_url) ||
    slides.some((s) => Boolean(s.design_id || s.canva_url));

  // Derive the effective selection during render. If the user hasn't picked a
  // slide yet, or their pick no longer exists, fall back to the first slide.
  // This is the React-recommended "adjust state during render" pattern for
  // derived state — avoids a cascading setState-in-effect.
  const exists = selected !== null && slides.some((s) => s.index === selected);
  const effectiveSelected = slides.length === 0 ? null : exists ? selected : slides[0].index;
  if (effectiveSelected !== selected) {
    setSelected(effectiveSelected);
  }

  const selectedSlide = slides.find((s) => s.index === effectiveSelected) ?? null;
  const candidates = state?.candidates;
  const isAwaitingSelection = phase === "awaiting_candidate_selection";

  return (
    <div className="flex h-full flex-col">
      <StudioToolbar
        hasDesign={hasDesign}
        design={state?.design}
        slideCanvaUrl={selectedSlide?.canva_url}
        slideNumber={selectedSlide ? selectedSlide.index + 1 : undefined}
        mode={state?.mode}
      />

      {(() => {
        const rawErrors = state?.errors ?? [];
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

      {/* Candidate selection (deck mode pause) — replaces the preview area. */}
      {isAwaitingSelection && candidates && candidates.length > 0 ? (
        <div className="flex min-h-0 flex-1 items-center overflow-y-auto border-b border-white/10">
          <CandidateStrip
            instanceId={instanceId}
            candidates={candidates}
            interactive={true}
          />
        </div>
      ) : candidates && candidates.length > 0 && !hasExports ? (
        /* Informational candidate strip during generation (before exports land). */
        <div className="shrink-0 border-b border-white/10">
          <CandidateStrip instanceId={instanceId} candidates={candidates} interactive={false} />
        </div>
      ) : null}

      {/* Preview + copy panel — hidden while the deck-selection strip is shown. */}
      {!(isAwaitingSelection && candidates && candidates.length > 0) && (
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_280px]">
          <div className="min-h-0 min-w-0 p-4">
            <SlidePreview instanceId={instanceId} slide={selectedSlide} phase={phase} version={version} />
          </div>
          <aside className="min-h-0 overflow-y-auto border-l border-white/10 bg-[var(--card)]/20">
            <SlideCopyPanel slide={selectedSlide} />
          </aside>
        </div>
      )}

      {/* Filmstrip — hidden during deck selection (no slides to show yet). */}
      {!isAwaitingSelection && (
        <div className="shrink-0 border-t border-white/10 bg-[var(--card)]/20">
          <Filmstrip
            instanceId={instanceId}
            slides={slides}
            selectedIndex={selected}
            phase={phase}
            onSelect={setSelected}
            version={version}
          />
        </div>
      )}
    </div>
  );
}
