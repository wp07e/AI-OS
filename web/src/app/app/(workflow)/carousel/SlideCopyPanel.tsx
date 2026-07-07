"use client";

import type { CarouselSlide } from "./types";

interface Props {
  /** Selected slide, or null. */
  slide: CarouselSlide | null;
}

/**
 * Read-only headline/body/cta for the selected slide (from brief.json, surfaced
 * via state.json). Per spec §2.2 edits go through the agent — there is no
 * direct text editing in the canvas. The user types in the agent panel, the
 * agent rewrites brief.json/state.json, the next poll updates this view.
 */
export function SlideCopyPanel({ slide }: Props) {
  if (!slide) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-[var(--muted)]">
        No slide selected.
      </div>
    );
  }

  const rows: { label: string; value?: string }[] = [
    { label: "Headline", value: slide.headline },
    { label: "Body", value: slide.body },
    { label: "CTA", value: slide.cta },
  ];
  const hasAny = rows.some((r) => r.value);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          Slide {slide.index + 1} copy
        </p>
        {slide.archetype && (
          <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 font-mono text-[9px] text-[var(--muted)]">
            {slide.archetype}
          </span>
        )}
      </div>

      {!hasAny ? (
        <p className="text-xs text-[var(--muted)]">
          No copy captured yet for this slide. It will appear once the agent plans the carousel.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map(
            (r) =>
              r.value && (
                <div key={r.label}>
                  <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
                    {r.label}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm text-[var(--foreground)]">{r.value}</p>
                </div>
              ),
          )}
        </div>
      )}

      <p className="mt-auto text-[10px] text-[var(--muted)]">
        To edit, tell the agent — e.g. <span className="font-mono">“shorten slide {slide.index + 1}’s body.”</span>
      </p>
    </div>
  );
}
