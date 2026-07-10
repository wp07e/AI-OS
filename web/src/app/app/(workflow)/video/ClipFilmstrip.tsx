"use client";

import type { VideoClip } from "./types";
import { fileUrl } from "./lib";

interface Props {
  instanceId: string;
  clips: VideoClip[];
  selectedIndex: number | null;
  /** Which clip index is currently being generated (for the pulse), if any. */
  inFlightIndex?: number | null;
  onSelect: (index: number) => void;
  onToggleInclude: (index: number) => void;
  onDelete: (index: number) => void;
  version?: string;
}

/**
 * Thumbnail row of clips. Click selects. The in-flight clip pulses. Each clip
 * has a small include/exclude checkbox for the final assembly, and an X button
 * (top-left) to delete it. New clips are added simply by generating from the
 * panel — there is no explicit "add" button.
 */
export function ClipFilmstrip({
  instanceId,
  clips,
  selectedIndex,
  inFlightIndex,
  onSelect,
  onToggleInclude,
  onDelete,
  version,
}: Props) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto px-4 py-3">
      {clips.length === 0 && (
        <span className="text-xs text-[var(--muted)]">Clips will appear here as you generate them.</span>
      )}
      {clips.map((clip) => {
        const selected = clip.index === selectedIndex;
        const inFlight = clip.index === inFlightIndex;
        return (
          <div
            key={clip.index}
            className={
              "group relative flex h-20 w-28 shrink-0 flex-col overflow-hidden rounded-lg border transition " +
              (selected ? "border-indigo-400 ring-2 ring-indigo-400/40" : "border-white/10 hover:border-white/30")
            }
          >
            <button
              type="button"
              onClick={() => onSelect(clip.index)}
              className="absolute inset-0"
              title={`Clip ${clip.index + 1}: ${clip.prompt.slice(0, 60)}`}
            />
            {clip.localPath ? (
              <video
                src={fileUrl(instanceId, clip.localPath, version)}
                poster={clip.posterPath ? fileUrl(instanceId, clip.posterPath, version) : undefined}
                className="pointer-events-none absolute inset-0 h-full w-full object-cover"
                muted
                preload="metadata"
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center">
                {inFlight ? (
                  <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
                ) : clip.status === "error" ? (
                  <span className="text-[10px] text-red-400">error</span>
                ) : (
                  <span className="text-xs font-medium text-[var(--muted)]">{clip.index + 1}</span>
                )}
              </div>
            )}
            {/* Delete X — top-left, appears on hover */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(clip.index);
              }}
              className="absolute left-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-black/70 text-[9px] text-white/70 opacity-0 transition group-hover:opacity-100 hover:bg-red-500 hover:text-white"
              title="Delete clip"
            >
              ✕
            </button>
            {/* Continuity badge — top-right */}
            {clip.continuity !== "none" && (
              <span className="absolute right-1 top-1 rounded bg-indigo-500/80 px-1 text-[8px] font-medium text-white">
                {clip.continuity === "extend" ? "↻" : "→"}
              </span>
            )}
            {/* number + include toggle */}
            <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent px-1 pb-0.5 pt-2">
              <span className="rounded bg-black/50 px-1 text-[9px] font-medium text-white/80">
                {clip.index + 1}
                {clip.duration != null ? ` · ${clip.duration}s` : ""}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleInclude(clip.index);
                }}
                className={
                  "grid h-3.5 w-3.5 place-items-center rounded text-[8px] " +
                  (clip.included ? "bg-emerald-500 text-white" : "bg-black/50 text-white/40")
                }
                title={clip.included ? "Included in final" : "Excluded"}
              >
                {clip.included ? "✓" : ""}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
