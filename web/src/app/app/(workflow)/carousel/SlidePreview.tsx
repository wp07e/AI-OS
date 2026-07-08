"use client";

import type { CarouselSlide } from "./types";

interface Props {
  /** Active instance id — used to build the /file URL. */
  instanceId: string;
  /** The slide to preview, or null when none selected. */
  slide: CarouselSlide | null;
  /** Current workflow phase — shapes the placeholder copy. */
  phase: string;
  /** Bumped whenever state.json changes — used as a cache-buster so edited
   *  PNGs re-fetch instead of showing the stale cached version. */
  version?: string;
}

/**
 * Big selected-slide PNG. Reads the render via the generic workspace file
 * endpoint. While no render exists yet (the agent hasn't exported, or this
 * slide hasn't been generated), shows a phase-aware placeholder.
 */
export function SlidePreview({ instanceId, slide, phase, version }: Props) {
  if (!slide) {
    return (
      <Placeholder text="No slide selected" hint="Pick a slide from the filmstrip below." working={false} />
    );
  }

  if (!slide.renderPath) {
    const hint = generatingHint(phase);
    return (
      <Placeholder
        text={`Slide ${slide.index + 1}`}
        hint={hint ?? "No render yet. The agent will export one as it works."}
        working={isWorking(phase)}
      />
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/workspace/${instanceId}/file/${slide.renderPath}${version ? `?v=${version}` : ""}`}
        alt={`Slide ${slide.index + 1}`}
        className="max-h-full max-w-full rounded-xl border border-white/10 object-contain shadow-2xl shadow-black/40"
      />
    </div>
  );
}

function Placeholder({ text, hint, working }: { text: string; hint: string; working: boolean }) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex aspect-[4/5] w-full max-w-sm flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/10 bg-white/[0.02] text-center">
        <div
          className={
            "h-2 w-2 rounded-full " +
            (working ? "animate-pulse bg-indigo-400" : "bg-[var(--muted)]")
          }
        />
        <p className="text-sm font-medium text-[var(--foreground)]">{text}</p>
        <p className="max-w-[16rem] text-xs text-[var(--muted)]">{hint}</p>
      </div>
    </div>
  );
}

function isWorking(phase: string): boolean {
  return phase !== "complete" && phase !== "unknown" && phase !== "—";
}

function generatingHint(phase: string): string | null {
  if (phase === "planning" || phase === "resolving_assets") return "Planning the carousel…";
  if (phase === "generating_design" || phase === "design_generated") return "Generating the design in Canva…";
  if (phase === "capturing_template" || phase === "template_captured") return "Capturing the template…";
  if (phase === "exporting") return "Exporting slides…";
  return null;
}
