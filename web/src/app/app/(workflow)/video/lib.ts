"use client";

import { useCallback, useEffect, useState } from "react";
import type { BrandAsset, BrandKit } from "@/lib/brand/types";
import type { Quality, VideoSettings } from "./types";

/**
 * Shared helpers for the Video Studio canvas: brand-kit loading, the generate
 * API call, and cost estimation.
 */

/** What the generate route expects in the POST body. */
export interface GenerateRequest {
  op: "generate_video" | "extend_video" | "generate_image" | "edit_image" | "assemble" | "extract_frame" | "delete_clip" | "toggle_include";
  prompt: string;
  quality: Quality;
  settings: VideoSettings;
  /** Brand asset ids to use as references (resolved server-side). */
  references: string[];
  sourceClipIndex?: number;
  seedPrompt?: string;
  startImageExport?: string;
  included?: boolean;
  continuity?: "none" | "extend" | "last_frame";
  clipIndices?: number[];
}

/** Fire-and-forget POST to the generate route. Returns ok/err. */
export async function postGenerate(instanceId: string, req: GenerateRequest): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/workspace/${instanceId}/video/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Load the user's brand kit (for the reference multi-select grid). */
export function useBrandKit() {
  const [kit, setKit] = useState<BrandKit | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/brand", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setKit(data.brand ?? data);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { kit, loading };
}

/**
 * Load the per-lane brand selection (which assets the user picked via the Brand
 * wizard for this specific lane). Returns the set of selected asset IDs — only
 * these assets should appear in the ReferenceGrid, not the entire brand kit.
 */
export function useLaneBrandAssets(instanceId: string, kit: BrandKit | null) {
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workflows/${instanceId}/brand-selection`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.selection) return;
        const sel = data.selection;
        // Flatten the per-category asset ID lists into one set.
        const ids = new Set<string>();
        if (sel.assets) {
          for (const catIds of Object.values(sel.assets)) {
            if (Array.isArray(catIds)) {
              for (const id of catIds) ids.add(id);
            }
          }
        }
        setSelectedAssetIds(ids);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [instanceId]);

  // Filter the kit to only selected assets.
  const assets: BrandAsset[] = kit?.assets.filter((a) => selectedAssetIds.has(a.id)) ?? [];
  return { assets, loading, selectedAssetIds };
}

export interface UploadedRef {
  path: string; // "uploads/<uuid>.<ext>"
  filename: string;
}

/** Load one-off reference images uploaded to this instance. */
export function useUploads(instanceId: string) {
  const [uploads, setUploads] = useState<UploadedRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspace/${instanceId}/video/upload`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setUploads(data.uploads ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [instanceId, nonce]);

  return { uploads, loading, refresh };
}

/** Upload a one-off reference image to the instance. */
export async function uploadReference(instanceId: string, file: File): Promise<UploadedRef | null> {
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch(`/api/workspace/${instanceId}/video/upload`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Cost estimation ────────────────────────────────────────────────────────
// Approximate per-generation cost. Derived from the provider pricing table.
// Surfaced as a small "≈ $X" hint — advisory, not billed here.

const IMAGE_COST: Record<string, number> = {
  // $/image
  "grok-imagine-image:1k": 0.002,
  "grok-imagine-image:2k": 0.002,
  "grok-imagine-image-quality:1k": 0.01,
  "grok-imagine-image-quality:2k": 0.07,
};

const VIDEO_COST_PER_SEC: Record<string, number> = {
  "grok-imagine-video:480p": 0.08,
  "grok-imagine-video:720p": 0.14,
  "grok-imagine-video-1.5:480p": 0.08,
  "grok-imagine-video-1.5:720p": 0.14,
  "grok-imagine-video-1.5:1080p": 0.25,
};

function imageModel(quality: Quality): string {
  return quality === "high" ? "grok-imagine-image-quality" : "grok-imagine-image";
}

function videoModel(quality: Quality): string {
  return quality === "high" ? "grok-imagine-video-1.5" : "grok-imagine-video";
}

/** Estimate the cost of an image generation. */
export function estimateImageCost(quality: Quality, resolution: string, n: number): string {
  const key = `${imageModel(quality)}:${resolution ?? "1k"}`;
  const per = IMAGE_COST[key] ?? 0.002;
  return formatCost(per * Math.max(1, n));
}

/** Estimate the cost of a video generation (plus a seed image if needed). */
export function estimateVideoCost(
  quality: Quality,
  resolution: string,
  duration: number,
  withSeed: boolean,
): string {
  const key = `${videoModel(quality)}:${resolution ?? "720p"}`;
  const perSec = VIDEO_COST_PER_SEC[key] ?? 0.14;
  let total = perSec * Math.max(1, duration);
  if (withSeed) {
    total += IMAGE_COST[`${imageModel(quality)}:1k`] ?? 0.01;
  }
  return formatCost(total);
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `<$0.01`;
  if (usd < 1) return `≈$${usd.toFixed(2)}`;
  return `≈$${usd.toFixed(2)}`;
}

/** Resolution options react to quality (1080p only for high video). */
export function videoResolutionOptions(quality: Quality): { value: string; label: string }[] {
  const base = [
    { value: "480p", label: "480p" },
    { value: "720p", label: "720p" },
  ];
  if (quality === "high") base.push({ value: "1080p", label: "1080p" });
  return base;
}

export function imageResolutionOptions(): { value: string; label: string }[] {
  return [
    { value: "1k", label: "1K" },
    { value: "2k", label: "2K" },
  ];
}

export const ASPECT_RATIOS = [
  { value: "16:9", label: "16:9 Landscape" },
  { value: "9:16", label: "9:16 Portrait" },
  { value: "1:1", label: "1:1 Square" },
];

/** Build a /api/workspace/<id>/file/<path>?v=<version> URL. */
export function fileUrl(instanceId: string, path: string, version?: string): string {
  const base = `/api/workspace/${instanceId}/file/${path}`;
  return version ? `${base}?v=${version}` : base;
}

/** Re-usable submit hook: tracks "submitting" state + error. */
export function useGenerateSubmit(instanceId: string) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (req: GenerateRequest) => {
      setSubmitting(true);
      setError(null);
      const res = await postGenerate(instanceId, req);
      setSubmitting(false);
      if (!res.ok) setError(res.error ?? "Failed to start generation");
      return res.ok;
    },
    [instanceId],
  );

  return { submit, submitting, error, clearError: () => setError(null) };
}
