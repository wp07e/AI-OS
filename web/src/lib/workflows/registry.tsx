import { CarouselStudio } from "@/app/app/(workflow)/carousel/CarouselStudio";
import { useCarouselState } from "@/app/app/(workflow)/carousel/useCarouselState";
import type { CarouselState } from "@/app/app/(workflow)/carousel/types";
import type { WorkflowDefinition } from "./types";

/**
 * The workflow registry. The shell reads this to render the rail and route
 * canvas components. Adding a workflow = adding one entry here plus dropping a
 * skill into container/skills/<type>/ — see
 * docs/superpowers/specs/2026-07-07-ai-os-shell-design.md Section 3.
 *
 * M3: The carousel entry now points at the real CarouselStudio canvas (slide
 * preview, filmstrip, copy panel, design card, chat-trigger toolbar). State is
 * observed via useCarouselState, which polls state.json and hydrates slides[],
 * brief, and design. The canva-carousel skill has been updated to write that
 * state at each phase boundary.
 */

// ── Icons ─────────────────────────────────────────────────────────────────

export function CarouselIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </svg>
  );
}

// ── Registry ───────────────────────────────────────────────────────────────
//
// Each entry is a WorkflowDefinition<S> with its own state generic. The map is
// typed with `any` for the state slot so entries with different S can coexist —
// this is the standard pattern for a plugin registry (precise per-entry types,
// opaque lookup from the shell). The shell passes state through without
// inspecting it, so the loose map type is safe at the use site.

const carouselDefinition: WorkflowDefinition<CarouselState> = {
  type: "carousel",
  label: "Carousel Studio",
  icon: CarouselIcon,
  description: "Turn AI copy into designed Instagram carousels via Canva.",
  folder: "carousels",
  skill: "canva-carousel",
  requiresCanva: true,
  Canvas: CarouselStudio,
  useState: useCarouselState,
  sessionPrompt: [
    "You are working in the Carousel Studio workflow.",
    "For generation, the SKILL.md tells you to write brief.json and run a deterministic script — do NOT call Canva generation tools (generate-design, create-design-from-candidate, export-design) yourself; the script owns those.",
    "Before acting, read memory.md and state.json in the instance folder if they exist, to pick up where a previous session left off.",
    "When you reach a meaningful milestone (starting a phase, finishing a step, hitting an error), update state.json with at least: {\"phase\": \"<current-phase>\", \"lastUpdated\": \"<ISO timestamp>\", \"errors\": [<any issues>]}.",
    "Keep state.json enriched with the workflow fields the canvas reads: brief {topic, aspect_ratio, slide_count}, slides[] (index, headline, body, cta, archetype), and design {design_id, canva_url} once known.",
    "When you pause or finish, append a short handoff note to memory.md so the next session can resume.",
    "All paths you read or write are relative to the instance folder unless absolute.",
  ].join(" "),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WORKFLOW_REGISTRY: Record<string, WorkflowDefinition<any>> = {
  carousel: carouselDefinition,
};

export type WorkflowType = keyof typeof WORKFLOW_REGISTRY;

/** All registered workflow types, in registry order. */
export const WORKFLOW_TYPES = Object.keys(WORKFLOW_REGISTRY) as WorkflowType[];

/** Convenience lookup with a typed fallback. */
export function getWorkflow(type: string): WorkflowDefinition | null {
  return (WORKFLOW_REGISTRY as Record<string, WorkflowDefinition>)[type] ?? null;
}
