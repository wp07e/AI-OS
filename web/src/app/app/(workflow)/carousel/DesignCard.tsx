"use client";

interface Props {
  /** Deck-level Canva link (deck mode, or posts mode's first design). Optional. */
  canvaUrl?: string;
  /** Per-slide Canva link (posts mode: the selected slide's own design). Optional. */
  slideCanvaUrl?: string;
  /** Which slide the per-slide link opens (1-indexed, for the label). */
  slideNumber?: number;
}

/**
 * "Designed in Canva" link card. Dual-mode:
 * - Posts mode: each slide has its own design → "Open slide N in Canva"
 * - Deck mode: one deck → "Open in Canva"
 * Renders nothing if no URL is available yet.
 */
export function DesignCard({ canvaUrl, slideCanvaUrl, slideNumber }: Props) {
  const url = slideCanvaUrl ?? canvaUrl;
  if (!url) return null;

  const label = slideCanvaUrl
    ? `Open slide ${slideNumber ?? ""} in Canva`
    : "Designed in Canva";

  return (
    <a
      href={url}
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
      {label}
      <span className="text-emerald-300/70 transition group-hover:text-emerald-200">↗</span>
    </a>
  );
}
