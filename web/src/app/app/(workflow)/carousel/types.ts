import type { WorkflowState } from "@/lib/workflows/types";

/**
 * Carousel Studio state shape. The skill writes these fields into `state.json`
 * as it progresses; the canvas reads them via the generic `/api/workspace/<id>/state`
 * poll (which spreads `state.json` straight through).
 *
 * See docs/superpowers/specs/2026-07-07-ai-os-shell-design.md §2.3–2.4.
 */

/** One slide of the carousel. Copy is read-only in the canvas (edits go via the agent). */
export interface CarouselSlide {
  /** 0-based slide index. */
  index: number;
  headline?: string;
  body?: string;
  cta?: string;
  /** Archetype from the brief (hero/split/editorial/...) — advisory, from `layouts.registry.jsonc`. */
  archetype?: string;
  /** Relative path to the rendered PNG, e.g. "exports/slide-01.png". Joined by the
   *  parser from the exports[] list; null until the render exists. */
  renderPath?: string | null;
}

/** Top-level brief metadata the canvas surfaces. */
export interface CarouselBrief {
  topic?: string;
  aspect_ratio?: string;
  slide_count?: number;
}

/** Canva design link, filled once Phase 3 completes. */
export interface CarouselDesign {
  design_id?: string;
  canva_url?: string;
}

export interface CarouselState extends WorkflowState {
  brief?: CarouselBrief;
  /** Always a (possibly empty) array after parsing. */
  slides: CarouselSlide[];
  design?: CarouselDesign;
  /** Files present in the instance folder (name → true). From the workspace listing. */
  files: Record<string, boolean>;
  /** Rendered exports, relative paths: "exports/slide-01.png". */
  exports: string[];
}
