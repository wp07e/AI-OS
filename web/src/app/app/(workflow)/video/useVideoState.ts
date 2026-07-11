"use client";

import { useWorkspaceState } from "@/lib/hooks/useWorkspaceState";
import type { AutomationProgress, ClipStatus, GeneratedImage, VideoClip, VideoState } from "./types";

/**
 * Video Studio state observer. Wraps the generic focus-aware poller with a
 * parser that hydrates the workflow-specific fields (clips, images, finalVideo)
 * and joins rendered export files to their clip/image entries.
 *
 * The script writes `clips[]` / `images[]` / `finalVideo` straight into
 * `state.json`; `/api/workspace/<id>/state` spreads them through. Clip artifacts
 * come back as `exports[]` (relative paths like "exports/clip-01.mp4"); the
 * script also writes explicit paths on each clip, but we defensively join from
 * `exports[]` as a fallback (mirroring carousel's `findRender`).
 */
export function useVideoState(instanceId: string, folder: string) {
  // `folder` is part of the WorkflowDefinition.useState contract. Unused today
  // (the state endpoint returns everything this canvas needs) but reserved.
  void folder;
  return useWorkspaceState<VideoState>(instanceId, {
    intervalMs: 2500,
    parse: (raw) => ({
      phase: raw.phase,
      lastUpdated: raw.lastUpdated,
      errors: raw.errors ?? [],
      mode: parseMode(raw.mode),
      active: parseActive(raw.active),
      clips: parseClips(raw.clips, raw.exports),
      images: parseImages(raw.images, raw.exports),
      finalVideo: parseFinalVideo(raw.finalVideo),
      automation: parseAutomation(raw.automation),
      files: raw.files ?? {},
      exports: raw.exports ?? [],
    }),
  });
}

function parseMode(raw: unknown): "video" | "image" | undefined {
  return raw === "video" || raw === "image" ? raw : undefined;
}

function parseActive(raw: unknown): VideoState["active"] {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const op = typeof a.op === "string" ? a.op : undefined;
  const label = typeof a.label === "string" ? a.label : undefined;
  if (!op && !label) return null;
  return {
    op: op ?? "",
    label: label ?? "",
    targetIndex: typeof a.targetIndex === "number" ? a.targetIndex : undefined,
  };
}

/** Coerce unknown clips into typed clips; defensively attach export paths. */
function parseClips(raw: unknown, exports: unknown): VideoClip[] {
  if (!Array.isArray(raw)) return [];
  const exportList = Array.isArray(exports) ? (exports as string[]) : [];
  return raw
    .map((entry, i): VideoClip | null => {
      if (!entry || typeof entry !== "object") return null;
      const c = entry as Record<string, unknown>;
      const index = typeof c.index === "number" ? c.index : i;
      return {
        index,
        prompt: asString(c.prompt) ?? "",
        sourceType: c.sourceType === "text" || c.sourceType === "image" ? c.sourceType : "text",
        quality: c.quality === "high" ? "high" : "low",
        continuity:
          c.continuity === "extend" || c.continuity === "last_frame" ? c.continuity : "none",
        seedFromClip: typeof c.seedFromClip === "number" ? c.seedFromClip : undefined,
        seedPrompt: asString(c.seedPrompt),
        seedImagePath: asString(c.seedImagePath) ?? findExport(exportList, index, "frame.png"),
        settings: parseSettings(c.settings),
        references: asStringArray(c.references),
        startImageExport: asString(c.startImageExport),
        included: c.included !== false, // default true unless explicitly false
        status: parseStatus(c.status),
        localPath: asString(c.localPath) ?? findExport(exportList, index, ".mp4"),
        posterPath: asString(c.posterPath) ?? findExport(exportList, index, ".jpg"),
        sourceUrl: asString(c.sourceUrl),
        duration: typeof c.duration === "number" ? c.duration : undefined,
        error: asString(c.error),
      };
    })
    .filter((c): c is VideoClip => c !== null);
}

function parseImages(raw: unknown, exports: unknown): GeneratedImage[] {
  if (!Array.isArray(raw)) return [];
  const exportList = Array.isArray(exports) ? (exports as string[]) : [];
  return raw
    .map((entry, i): GeneratedImage | null => {
      if (!entry || typeof entry !== "object") return null;
      const g = entry as Record<string, unknown>;
      const id = asString(g.id) ?? `img-${String(i + 1).padStart(2, "0")}`;
      const explicit = asString(g.localPath);
      const fallback = explicit ?? findImageExport(exportList, i + 1);
      return {
        id,
        prompt: asString(g.prompt) ?? "",
        quality: g.quality === "high" ? "high" : "low",
        references: asStringArray(g.references),
        localPath: fallback,
        sourceUrl: asString(g.sourceUrl),
        revisedPrompt: asString(g.revisedPrompt),
        status: parseStatus(g.status),
      };
    })
    .filter((g): g is GeneratedImage => g !== null);
}

function parseFinalVideo(raw: unknown): VideoState["finalVideo"] {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const localPath = asString(f.localPath);
  if (!localPath) return null;
  const clipIndices = Array.isArray(f.clipIndices)
    ? (f.clipIndices as unknown[]).filter((n): n is number => typeof n === "number")
    : [];
  return {
    localPath,
    duration: typeof f.duration === "number" ? f.duration : undefined,
    clipCount: typeof f.clipCount === "number" ? f.clipCount : clipIndices.length,
    clipIndices,
    builtAt: asString(f.builtAt) ?? new Date().toISOString(),
  };
}

function parseSettings(raw: unknown): VideoClip["settings"] {
  if (!raw || typeof raw !== "object") return { quality: "low" };
  const s = raw as Record<string, unknown>;
  return {
    quality: s.quality === "high" ? "high" : "low",
    duration: typeof s.duration === "number" ? s.duration : undefined,
    aspect_ratio: asString(s.aspect_ratio),
    resolution: asString(s.resolution),
    n: typeof s.n === "number" ? s.n : undefined,
  };
}

function parseStatus(raw: unknown): ClipStatus {
  if (raw === "pending" || raw === "generating" || raw === "ready" || raw === "error") return raw;
  return "pending";
}

/**
 * Find a clip artifact in exports[] by index and suffix.
 * e.g. findExport(exports, 0, ".mp4") → "exports/clip-01.mp4".
 */
function findExport(exports: string[], clipIndex: number, suffix: string): string | null {
  const target = String(clipIndex + 1).padStart(2, "0");
  return exports.find((p) => p.includes(`clip-${target}`) && p.endsWith(suffix)) ?? null;
}

/** Find an image export by 1-based number, e.g. findImageExport(exports, 1) → "exports/img-01.png". */
function findImageExport(exports: string[], imgNumber: number): string | null {
  const target = String(imgNumber).padStart(2, "0");
  return exports.find((p) => p.includes(`img-${target}`) && /\.(png|jpe?g|webp)$/i.test(p)) ?? null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseAutomation(raw: unknown): AutomationProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.totalClips !== "number") return null;
  return {
    totalClips: a.totalClips,
    completedClips: typeof a.completedClips === "number" ? a.completedClips : 0,
    failedClips: typeof a.failedClips === "number" ? a.failedClips : 0,
    currentClip: typeof a.currentClip === "number" ? a.currentClip : 0,
    phase: typeof a.phase === "string" ? a.phase : "preparing",
    startedAt: typeof a.startedAt === "string" ? a.startedAt : new Date().toISOString(),
    estimatedMinutes: typeof a.estimatedMinutes === "number" ? a.estimatedMinutes : undefined,
  };
}
