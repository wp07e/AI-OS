"use client";

import type { VideoClip } from "./types";
import { fileUrl } from "./lib";

interface Props {
  instanceId: string;
  clip: VideoClip | null;
  version?: string;
  /** Called when the include-in-final toggle is clicked. */
  onToggleInclude?: (index: number) => void;
}

/**
 * Big selected-clip player. Renders the mp4 via the generic workspace file
 * endpoint with a poster frame. While a clip has no render yet, shows a
 * phase-aware placeholder.
 */
export function ClipPlayer({ instanceId, clip, version, onToggleInclude }: Props) {
  if (!clip) {
    return <Placeholder text="No clip selected" hint="Pick a clip from the filmstrip, or generate a new one." />;
  }

  if (!clip.localPath) {
    const working = clip.status === "generating" || clip.status === "pending";
    return (
      <Placeholder
        text={`Clip ${clip.index + 1}`}
        hint={clip.error ?? (working ? "Generating… the script will download the video when ready." : "No render yet.")}
        working={working}
      />
    );
  }

  const src = fileUrl(instanceId, clip.localPath, version);
  const poster = clip.posterPath ? fileUrl(instanceId, clip.posterPath, version) : undefined;

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2">
      <video
        key={src}
        controls
        poster={poster}
        className="max-h-[calc(100%-3rem)] max-w-full rounded-xl border border-white/10 bg-black shadow-2xl shadow-black/40"
      >
        <source src={src} type="video/mp4" />
      </video>
      <div className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
        <Badge label={`Clip ${clip.index + 1}`} />
        <Badge label={clip.sourceType === "image" ? "image→video" : "text→video"} />
        <Badge label={clip.quality === "high" ? "high" : "low"} />
        {clip.continuity !== "none" && (
          <Badge label={clip.continuity === "extend" ? "extended" : `from clip ${(clip.seedFromClip ?? 0) + 1}`} />
        )}
        {clip.duration != null && <span>{clip.duration}s</span>}
        {onToggleInclude && (
          <button
            type="button"
            onClick={() => onToggleInclude(clip.index)}
            className={
              "ml-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition " +
              (clip.included
                ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300"
                : "border-white/10 bg-white/[0.02] text-[var(--muted)]")
            }
            title={clip.included ? "Included in final video" : "Excluded from final video"}
          >
            {clip.included ? "✓ in final" : "excluded"}
          </button>
        )}
      </div>
      <p className="max-w-xl text-center text-xs text-[var(--foreground)]/70">{clip.prompt}</p>
    </div>
  );
}

function Placeholder({ text, hint, working }: { text: string; hint?: string; working?: boolean }) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex aspect-video w-full max-w-lg flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/10 bg-white/[0.02] text-center">
        <div className={"h-2 w-2 rounded-full " + (working ? "animate-pulse bg-indigo-400" : "bg-[var(--muted)]")} />
        <p className="text-sm font-medium text-[var(--foreground)]">{text}</p>
        {hint && <p className="max-w-[16rem] text-xs text-[var(--muted)]">{hint}</p>}
      </div>
    </div>
  );
}

function Badge({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] font-medium text-[var(--foreground)]/70">
      {label}
    </span>
  );
}
