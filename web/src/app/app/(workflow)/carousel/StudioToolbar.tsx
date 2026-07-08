"use client";

import { useState } from "react";
import { useAgentChatContext } from "@/lib/hooks/AgentChatContext";
import { DesignCard } from "./DesignCard";
import type { CarouselDesign } from "./types";

interface Props {
  /** Instance title, for the toolbar header. */
  title: string;
  /** Current workflow phase string. */
  phase: string;
  /** True once a Canva design_id/url has been captured. */
  hasDesign: boolean;
  /** The Canva design link (rendered via DesignCard). */
  design?: CarouselDesign;
  /** Per-slide Canva link for the selected slide (posts mode). */
  slideCanvaUrl?: string;
  /** 1-indexed slide number, for the "Open slide N in Canva" label. */
  slideNumber?: number;
}

/**
 * Studio toolbar. Phase pill on the left; chat-trigger action buttons on the
 * right. Per the chosen "chat-trigger buttons" model (spec §2.2), each action
 * posts a templated message to the agent panel via AgentChatContext — the agent
 * remains the single writer. "Open in Canva ↗" is a plain link, not a chat
 * action.
 *
 * Buttons shown adapt to the workflow's progress:
 *  - Generate: before any design exists (kick off the whole pipeline)
 *  - Reset: always (with confirm)
 */
export function StudioToolbar({ title, phase, hasDesign, design, slideCanvaUrl, slideNumber }: Props) {
  const chat = useAgentChatContext();
  const [confirmingReset, setConfirmingReset] = useState(false);
  const busy = chat.busy;

  const showGenerate = !hasDesign;

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-white/10 bg-[var(--card)]/30 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <PhasePill phase={phase} />
          <h2 className="truncate text-sm font-semibold text-[var(--foreground)]">{title}</h2>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <DesignCard
            canvaUrl={design?.canva_url}
            slideCanvaUrl={slideCanvaUrl}
            slideNumber={slideNumber}
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
      </div>
    </div>
  );
}

function PhasePill({ phase }: { phase: string }) {
  const tone = toneForPhase(phase);
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium " + tone.cls
      }
      title={phase}
    >
      <span className={"h-1.5 w-1.5 rounded-full " + tone.dot} />
      {tone.label}
    </span>
  );
}

function toneForPhase(phase: string): { cls: string; dot: string; label: string } {
  const base = "border-white/10 bg-black/20 text-[var(--muted)]";
  if (phase === "complete")
    return { cls: "border-emerald-400/30 bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400", label: "Complete" };
  if (phase === "unknown" || phase === "—" || !phase)
    return { cls: base, dot: "bg-[var(--muted)]", label: "Idle" };
  if (phase.startsWith("error") || phase === "failed")
    return { cls: "border-red-400/30 bg-red-500/10 text-red-300", dot: "bg-red-400", label: "Error" };
  return {
    cls: "border-indigo-400/30 bg-indigo-500/10 text-indigo-300",
    dot: "animate-pulse bg-indigo-400",
    label: prettify(phase),
  };
}

function prettify(phase: string): string {
  return phase
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
