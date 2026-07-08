"use client";

import { useState } from "react";
import type { CarouselCandidate } from "./types";

interface Props {
  /** Active instance id — for the select-candidate call. */
  instanceId: string;
  /** Candidate decks to render. */
  candidates: CarouselCandidate[];
  /** True when the user can pick (deck mode at awaiting_candidate_selection). */
  interactive: boolean;
  /** Called after a successful selection (lets the parent reset UI). */
  onSelected?: () => void;
}

/**
 * Candidate deck strip.
 *
 * - **Deck mode, phase `awaiting_candidate_selection` (interactive)**: renders
 *   each candidate as a clickable card with its first-slide thumbnail. On click,
 *   POSTs to /api/workspace/<id>/select-candidate; the host re-runs the pipeline
 *   with --selected-candidate and the canvas returns to polling.
 * - **Posts mode / during generation (informational)**: non-interactive
 *   thumbnails showing what Canva produced. Vanishes when exports land.
 *
 * Thumbnails are public Canva PNG URLs (https://design.canva.ai/...) — no auth
 * needed, renderable as plain <img src>.
 */
export function CandidateStrip({ instanceId, candidates, interactive, onSelected }: Props) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!candidates || candidates.length === 0) return null;

  async function pick(c: CarouselCandidate) {
    if (submitting) return;
    setSubmitting(c.id);
    setError(null);
    try {
      const res = await fetch(`/api/workspace/${instanceId}/select-candidate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: c.id }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      // The host re-runs the script fire-and-forget; the canvas keeps polling
      // state.json and will transition out of awaiting_candidate_selection.
      onSelected?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "selection failed");
      setSubmitting(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <span className="grid h-2 w-2 place-items-center">
          <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
        </span>
        <p className="text-sm font-medium text-[var(--foreground)]">
          {interactive ? "Pick a deck design" : "Generating"}
        </p>
        <p className="text-xs text-[var(--muted)]">
          {interactive
            ? `${candidates.length} candidate decks ready — click one to continue`
            : `${candidates.length} candidates from Canva`}
        </p>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {candidates.map((c, i) => {
          const disabled = submitting !== null;
          const isSubmittingThis = submitting === c.id;
          return (
            <button
              key={c.id}
              type="button"
              disabled={!interactive || disabled}
              onClick={() => interactive && pick(c)}
              className={
                "group relative flex w-44 shrink-0 flex-col gap-2 rounded-xl border p-2 text-left transition " +
                (interactive && !disabled
                  ? "border-white/10 hover:border-indigo-400/60 hover:bg-white/[0.03] cursor-pointer"
                  : "border-white/10 cursor-default")
              }
            >
              <div className="relative aspect-[16/9] w-full overflow-hidden rounded-lg border border-white/10 bg-black/30">
                {c.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={c.thumbnailUrl}
                    alt={`Candidate ${i + 1}`}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-[var(--muted)]">
                    Deck {i + 1}
                  </div>
                )}
                {isSubmittingThis && (
                  <div className="absolute inset-0 grid place-items-center bg-black/60">
                    <span className="text-xs text-white">Resuming…</span>
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between px-1">
                <span className="text-xs font-medium text-[var(--foreground)]">Deck {i + 1}</span>
                {c.slideCount ? (
                  <span className="text-[10px] text-[var(--muted)]">{c.slideCount} slides</span>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>

      {error && (
        <p className="text-xs text-red-300">{error}</p>
      )}
    </div>
  );
}
