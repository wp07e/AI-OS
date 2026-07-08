/**
 * Shared phase indicator pill. Color-coded by workflow phase:
 *   complete  → emerald
 *   error     → red
 *   active    → indigo (pulsing dot)
 *   idle/none → muted
 *
 * Used in the shell chrome sub-header (CanvasArea) and inside workflow-specific
 * toolbars (e.g. StudioToolbar). Extracted from StudioToolbar.tsx so both the
 * shell and the canvas can share the same visual treatment.
 */
export function PhasePill({ phase }: { phase: string }) {
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

export function toneForPhase(phase: string): { cls: string; dot: string; label: string } {
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

export function prettify(phase: string): string {
  return phase
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
