"use client";

import { useWorkspaceState } from "@/lib/hooks/useWorkspaceState";
import type { CarouselState, CarouselSlide } from "./types";

/**
 * Carousel Studio state observer. Wraps the generic focus-aware poller with a
 * parser that hydrates the workflow-specific fields (brief, slides, design) and
 * joins rendered export PNGs to their slide entries.
 *
 * The skill writes `slides[]` / `brief` / `design` straight into `state.json`;
 * `/api/workspace/<id>/state` spreads them through. The render thumbnails come
 * back as `exports[]` (relative paths like "exports/slide-01.png"); we attach
 * each to its slide by parsing the slide number from the filename.
 */
export function useCarouselState(instanceId: string, folder: string) {
  // `folder` is part of the WorkflowDefinition.useState contract (the shell
  // passes the instance's absolute workspace folder). It's unused here today —
  // the generic /api/workspace/<id>/state endpoint already returns everything
  // this canvas needs — but is reserved for workflows that want to construct
  // deep file URLs without a server round-trip. Reference it to satisfy the
  // unused-arg check without stripping the contract.
  void folder;
  return useWorkspaceState<CarouselState>(instanceId, {
    intervalMs: 2500,
    parse: (raw) => {
      const slides = parseSlides(raw.slides, raw.exports);
      return {
        phase: raw.phase,
        lastUpdated: raw.lastUpdated,
        errors: raw.errors ?? [],
        brief: parseBrief(raw.brief),
        slides,
        design: parseDesign(raw.design),
        files: raw.files ?? {},
        exports: raw.exports ?? [],
      };
    },
  });
}

/** Coerce an unknown value into a slides array, joining render paths from exports. */
function parseSlides(raw: unknown, exports: unknown): CarouselSlide[] {
  if (!Array.isArray(raw)) return [];
  const exportList = Array.isArray(exports) ? (exports as string[]) : [];
  return raw
    .map((entry, i): CarouselSlide | null => {
      if (!entry || typeof entry !== "object") return null;
      const s = entry as Record<string, unknown>;
      const index = typeof s.index === "number" ? s.index : i;
      return {
        index,
        headline: asString(s.headline),
        body: asString(s.body),
        cta: asString(s.cta),
        archetype: asString(s.archetype),
        renderPath: findRender(exportList, index),
      };
    })
    .filter((s): s is CarouselSlide => s !== null);
}

/** Match `exports/slide-NN.png` → slide index (1-based in filename, 0-based in state). */
function findRender(exports: string[], slideIndex: number): string | null {
  const target = String(slideIndex + 1).padStart(2, "0");
  // Prefer slide-NN.png, fall back to any export whose name contains that number.
  const exact = exports.find((p) => /slide[_-]0*\d+/i.test(p) && new RegExp(`0*${slideIndex + 1}\\b`).test(p));
  if (exact) return exact;
  const loose = exports.find((p) => p.includes(`slide-${target}`) || p.includes(`slide_${target}`));
  return loose ?? null;
}

function parseBrief(raw: unknown): CarouselState["brief"] {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  return {
    topic: asString(b.topic),
    aspect_ratio: asString(b.aspect_ratio),
    slide_count: typeof b.slide_count === "number" ? b.slide_count : undefined,
  };
}

function parseDesign(raw: unknown): CarouselState["design"] {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Record<string, unknown>;
  if (!asString(d.design_id) && !asString(d.canva_url)) return undefined;
  return {
    design_id: asString(d.design_id),
    canva_url: asString(d.canva_url),
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}
