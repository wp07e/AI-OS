"use client";

import type { ReactNode } from "react";
import type { BrandCardKey } from "@/lib/brand/cards";

interface Props {
  card: BrandCardKey;
  onBack: () => void;
  onAskAI: (card: BrandCardKey) => void;
  children: ReactNode;
}

const CARD_TITLES: Record<BrandCardKey, string> = {
  identity: "Identity",
  colors: "Colors",
  typography: "Typography",
  logo: "Logos",
  photo: "Photos / Backgrounds",
  component: "Components",
  icon: "Icons",
};

/**
 * Shared chrome for a single brand card's inner page: back button (left),
 * title, and an "Ask AI" button (right) that seeds the agent panel with
 * card-specific context. The page's editable content is passed as children.
 */
export function BrandCardPage({ card, onBack, onAskAI, children }: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Card sub-header: back + title + Ask AI */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-[var(--card)]/40 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={onBack}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[var(--muted)] transition hover:bg-white/5 hover:text-[var(--foreground)]"
            aria-label="Back to brand kit"
          >
            <BackIcon />
          </button>
          <h2 className="truncate text-xs font-semibold text-[var(--foreground)]">
            {CARD_TITLES[card]}
          </h2>
        </div>
        <button
          onClick={() => onAskAI(card)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-indigo-200 transition hover:bg-indigo-500/20"
        >
          <SparkIcon />
          Ask AI
        </button>
      </div>

      {/* Scrollable card content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl p-4">{children}</div>
      </div>
    </div>
  );
}

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
      <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" />
    </svg>
  );
}
