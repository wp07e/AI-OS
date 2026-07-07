"use client";

import type { CarouselSlide } from "./types";

interface Props {
  /** Active instance id — for thumbnail URLs. */
  instanceId: string;
  /** All slides, in order. */
  slides: CarouselSlide[];
  /** Currently selected slide index (0-based), or null. */
  selectedIndex: number | null;
  /** Current phase — used to pulse the in-progress slide. */
  phase: string;
  /** Select a slide. */
  onSelect: (index: number) => void;
}

/**
 * Thumbnail row. Click selects. Numbers slides 1-based; highlights the selected
 * slide; pulses the slide currently being generated when the agent is mid-export.
 */
export function Filmstrip({ instanceId, slides, selectedIndex, phase, onSelect }: Props) {
  if (slides.length === 0) {
    return (
      <div className="flex items-center justify-center px-4 py-6 text-xs text-[var(--muted)]">
        Slides will appear here as the agent plans the carousel.
      </div>
    );
  }

  const exporting = phase === "exporting";

  return (
    <div className="flex items-center gap-2 overflow-x-auto px-4 py-3">
      {slides.map((slide) => {
        const selected = slide.index === selectedIndex;
        return (
          <button
            key={slide.index}
            type="button"
            onClick={() => onSelect(slide.index)}
            className={
              "group relative flex h-20 w-16 shrink-0 flex-col items-center justify-center overflow-hidden rounded-lg border transition " +
              (selected
                ? "border-indigo-400 ring-2 ring-indigo-400/40"
                : "border-white/10 hover:border-white/30")
            }
            title={`Slide ${slide.index + 1}`}
          >
            {slide.renderPath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/workspace/${instanceId}/file/${slide.renderPath}`}
                alt={`Slide ${slide.index + 1}`}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <span className="text-xs font-medium text-[var(--muted)]">{slide.index + 1}</span>
            )}

            {/* slide number badge */}
            <span className="absolute bottom-0.5 right-0.5 rounded bg-black/60 px-1 text-[9px] font-medium text-white/80">
              {slide.index + 1}
            </span>

            {/* in-progress pulse */}
            {exporting && !slide.renderPath && (
              <span className="absolute left-1.5 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />
            )}
          </button>
        );
      })}
    </div>
  );
}
