"use client";

import type { CarouselDesign } from "./types";

interface Props {
  /** Canva design link, if a design has been generated. */
  design?: CarouselDesign;
}

/**
 * "Designed in Canva" link card. Shows once the agent has generated a design
 * (Phase 3). The Open-in-Canva anchor opens the design in a new tab — it is not
 * a chat action; everything else (edits, re-exports) goes through the agent.
 */
export function DesignCard({ design }: Props) {
  if (!design?.canva_url) return null;

  return (
    <a
      href={design.canva_url}
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:border-emerald-400/60 hover:bg-emerald-500/15"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M20 6L9 17l-5-5" />
      </svg>
      Designed in Canva
      <span className="text-emerald-300/70 transition group-hover:text-emerald-200">Open in Canva ↗</span>
    </a>
  );
}
