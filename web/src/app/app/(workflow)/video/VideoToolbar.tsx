"use client";

import type { VideoClip } from "./types";

interface Props {
  /** The selected clip (for regenerate context), or null. */
  selectedClip: VideoClip | null;
  /** True while any generation op or chat is running. */
  busy: boolean;
  onRegenerate: () => void;
}

/**
 * Video Studio action bar. Holds the Regenerate action for the selected clip.
 * Delete lives on the filmstrip (per-clip X overlay) so the user can see
 * exactly which clip they're removing. The Assemble affordance lives in
 * FinalVideoCard; the tab switch (Video|Image) lives in GeneratePanel.
 */
export function VideoToolbar({ selectedClip, busy, onRegenerate }: Props) {
  if (!selectedClip) return null;

  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-b border-white/10 bg-[var(--card)]/30 px-4 py-3">
      <button
        type="button"
        onClick={onRegenerate}
        disabled={busy}
        title="Regenerate this clip with its current settings"
        className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Working…" : "Regenerate"}
      </button>
    </div>
  );
}
