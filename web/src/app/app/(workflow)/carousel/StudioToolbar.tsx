"use client";

import { useState } from "react";
import { useAgentChatContext } from "@/lib/hooks/AgentChatContext";
import { DesignCard } from "./DesignCard";
import type { CarouselDesign } from "./types";

interface Props {
  /** True once a Canva design_id/url has been captured. */
  hasDesign: boolean;
  /** The Canva design link (rendered via DesignCard). */
  design?: CarouselDesign;
  /** Per-slide Canva link for the selected slide (posts mode). */
  slideCanvaUrl?: string;
  /** 1-indexed slide number, for the "Open slide N in Canva" label. */
  slideNumber?: number;
  /** Generation mode: "posts" = individual slides, "deck" = single presentation. */
  mode?: "posts" | "deck";
}

/**
 * Studio action bar. The instance title + phase pill now live in the shell
 * chrome sub-header (CanvasArea); this toolbar holds only the chat-trigger
 * action buttons (Generate, Reset) and the Canva design link.
 *
 * Per the chosen "chat-trigger buttons" model (spec §2.2), each action posts a
 * templated message to the agent panel via AgentChatContext — the agent remains
 * the single writer. "Open in Canva ↗" is a plain link, not a chat action.
 *
 * Buttons shown adapt to the workflow's progress:
 *  - Generate: before any design exists (kick off the whole pipeline)
 *  - Reset: always (with confirm)
 */
export function StudioToolbar({ hasDesign, design, slideCanvaUrl, slideNumber, mode }: Props) {
  const chat = useAgentChatContext();
  const [confirmingReset, setConfirmingReset] = useState(false);
  const busy = chat.busy;

  const showGenerate = !hasDesign;

  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-b border-white/10 bg-[var(--card)]/30 px-4 py-3">
      <DesignCard
        canvaUrl={design?.canva_url}
        slideCanvaUrl={slideCanvaUrl}
        slideNumber={slideNumber}
        mode={mode}
      />
      {showGenerate && (
        <ToolbarButton
          label={busy ? "Working…" : "Generate"}
          disabled={busy}
          onClick={() => chat.send("Generate a carousel from the current brief.")}
          primary
        />
      )}
      {confirmingReset ? (
        <>
          <ToolbarButton
            label="Confirm reset"
            disabled={busy}
            onClick={() => {
              setConfirmingReset(false);
              chat.send("Reset this instance: clear generated artifacts and start over.");
            }}
            danger
          />
          <ToolbarButton label="Cancel" disabled={busy} onClick={() => setConfirmingReset(false)} />
        </>
      ) : (
        <ToolbarButton label="Reset" disabled={busy} onClick={() => setConfirmingReset(true)} />
      )}
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  primary,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  const cls = primary
    ? "bg-indigo-500 text-white hover:bg-indigo-400 shadow-md shadow-indigo-500/20"
    : danger
      ? "bg-red-500/90 text-white hover:bg-red-500"
      : "border border-white/10 bg-white/[0.03] text-[var(--foreground)] hover:bg-white/[0.06]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 " +
        cls
      }
    >
      {label}
    </button>
  );
}
