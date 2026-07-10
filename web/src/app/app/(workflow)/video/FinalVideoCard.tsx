"use client";

interface Props {
  /** True while an assemble op is running. */
  assembling?: boolean;
  onAssemble: () => void;
  includedCount: number;
}

/**
 * Assemble button + status row. The final video itself is rendered in
 * VideoStudio's dedicated section (with player + download). This card just
 * holds the action and a count of included clips.
 */
export function FinalVideoCard({ assembling, onAssemble, includedCount }: Props) {
  return (
    <div className="shrink-0 border-b border-white/10 bg-[var(--card)]/20 px-4 py-2.5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onAssemble}
          disabled={assembling || includedCount === 0}
          className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {assembling ? "Assembling…" : "Assemble final video"}
        </button>
        <span className="text-[11px] text-[var(--muted)]">
          {includedCount} clip{includedCount === 1 ? "" : "s"} included
        </span>
      </div>
    </div>
  );
}
