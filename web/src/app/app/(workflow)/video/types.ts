import type { WorkflowState } from "@/lib/workflows/types";

/**
 * Video Studio state shape. The deterministic script (`container/video/run.py`)
 * writes these fields into `state.json` as it progresses; the canvas reads them
 * via the generic `/api/workspace/<id>/state` poll (which spreads `state.json`
 * straight through).
 *
 * The workflow is a storyboard of independent clips. Each clip is generated /
 * edited on its own and carries its own prompt, settings, and quality. An
 * Assemble step concatenates the included clips (in filmstrip order) into one
 * final video. See docs/superpowers/specs and WORKFLOWS.md for the contract.
 */

/** Quality selects the model; resolution is a separate secondary setting. */
export type Quality = "low" | "high";

export interface VideoSettings {
  /** Selects the model (low → grok-imagine-video, high → grok-imagine-video-1.5). */
  quality: Quality;
  /** Seconds, 1–15. Ignored when extending/editing. */
  duration?: number;
  /** "16:9" | "9:16" | "1:1". */
  aspect_ratio?: string;
  /** Video: "480p"|"720p"|"1080p". Image: "1k"|"2k". */
  resolution?: string;
  /** Image count (image generation only). */
  n?: number;
}

/** How a clip was produced: text-to-video vs image-to-video. */
export type ClipSourceType = "text" | "image";

export type ClipStatus = "pending" | "generating" | "ready" | "error";

/**
 * How a new clip relates to a previous one.
 *  - none:        independent (hard cut at the assembly boundary)
 *  - last_frame:  the new clip's starting frame is the final frame of a prior
 *                 clip (extracted via ffmpeg). Each clip keeps its own prompt.
 *  - extend:      xAI's native extend_video lengthens ONE clip seamlessly from
 *                 its own last frame. No prompt change mid-clip.
 */
export type Continuity = "none" | "extend" | "last_frame";

/** One clip in the storyboard. */
export interface VideoClip {
  /** 0-based clip index. */
  index: number;
  prompt: string;
  sourceType: ClipSourceType;
  quality: Quality;
  continuity: Continuity;
  /** For extend: the clip this extends. For last_frame: the clip whose final
   *  frame seeds this one. */
  seedFromClip?: number;
  /** Present when a seed frame was AI-generated inline (path-three). */
  seedPrompt?: string;
  /** Relative path to the generated seed frame, e.g. "exports/clip-01-frame.png". */
  seedImagePath?: string | null;
  settings: VideoSettings;
  /** Brand asset ids / labels used as references. */
  references: string[];
  /** Brand ref / instance image / extracted last-frame used as the starting frame. */
  startImageExport?: string;
  /** Included in the final assembled video (default true). */
  included: boolean;
  status: ClipStatus;
  /** Relative path to the downloaded mp4, e.g. "exports/clip-01.mp4". */
  localPath?: string | null;
  /** Poster frame for <video poster>, e.g. "exports/clip-01.jpg". */
  posterPath?: string | null;
  /** The live xAI result URL (used as the source for extend/edit while fresh). */
  sourceUrl?: string;
  /** Actual seconds returned by xAI. */
  duration?: number;
  error?: string;
}

/** One generated image (Image tab). */
export interface GeneratedImage {
  id: string;
  prompt: string;
  quality: Quality;
  references: string[];
  /** Relative path to the downloaded image, e.g. "exports/img-01.png". */
  localPath?: string | null;
  sourceUrl?: string;
  revisedPrompt?: string;
  status: ClipStatus;
}

/** The assembled final video (Assemble step). */
export interface FinalVideo {
  /** Relative path, e.g. "exports/final.mp4". */
  localPath: string;
  duration?: number;
  clipCount: number;
  /** Included clips, in order. */
  clipIndices: number[];
  builtAt: string;
}

/** Progress tracking for an automation run. Written by the script's
 *  _do_automate op into state.json["automation"]. The canvas reads it
 *  to render a progress bar during long automation runs. */
export interface AutomationProgress {
  totalClips: number;
  completedClips: number;
  failedClips: number;
  currentClip: number;
  /** "preparing" | "generating" | "assembling" | "complete" */
  phase: string;
  startedAt: string;
  estimatedMinutes?: number;
}

export interface VideoState extends WorkflowState {
  /** Active tab (advisory; the canvas also keeps its own UI state). */
  mode?: "video" | "image";
  /** The generation request currently in flight (for phase display). */
  active?: { op: string; label: string; targetIndex?: number } | null;
  /** Always a (possibly empty) array after parsing. */
  clips: VideoClip[];
  images: GeneratedImage[];
  /** Present once Assemble has produced exports/final.mp4. */
  finalVideo?: FinalVideo | null;
  /** Present during an automation run (op: "automate"). */
  automation?: AutomationProgress | null;
  /** Files present in the instance folder (name → true). From the workspace listing. */
  files: Record<string, boolean>;
  /** Rendered exports, relative paths. */
  exports: string[];
}
