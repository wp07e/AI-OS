import { CarouselStudio } from "@/app/app/(workflow)/carousel/CarouselStudio";
import { useCarouselState } from "@/app/app/(workflow)/carousel/useCarouselState";
import type { CarouselState } from "@/app/app/(workflow)/carousel/types";
import { VideoStudio } from "@/app/app/(workflow)/video/VideoStudio";
import { useVideoState } from "@/app/app/(workflow)/video/useVideoState";
import type { VideoState } from "@/app/app/(workflow)/video/types";
import { BlenderStudio } from "@/app/app/(workflow)/blender/BlenderStudio";
import { useBlenderState } from "@/app/app/(workflow)/blender/useBlenderState";
import type { BlenderState } from "@/app/app/(workflow)/blender/types";
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

export function VideoIcon({ className }: { className?: string }) {
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
      <rect x="2" y="5" width="14" height="14" rx="2" />
      <path d="M16 10l6-3v10l-6-3" />
    </svg>
  );
}

export function BlenderIcon({ className }: { className?: string }) {
  // A cube — represents 3D scene work.
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
      <path d="M12 2L3 7v10l9 5 9-5V7l-9-5z" />
      <path d="M3 7l9 5 9-5" />
      <path d="M12 22V12" />
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

const videoDefinition: WorkflowDefinition<VideoState> = {
  type: "video",
  label: "Video Studio",
  icon: VideoIcon,
  description: "Generate and assemble image and video clips from brand assets.",
  folder: "videos",
  skill: "video",
  Canvas: VideoStudio,
  useState: useVideoState,
  sessionPrompt: [
    "You are working in the Video Studio workflow.",
    "For any generation, edit, extend, or assemble action, the SKILL.md tells you to write request.json and run a deterministic script — do NOT call image/video generation tools or ffmpeg yourself; the script owns those.",
    "Before acting, read memory.md and state.json in the instance folder if they exist, to pick up where a previous session left off.",
    "When you reach a meaningful milestone (starting a phase, finishing a step, hitting an error), update state.json with at least: {\"phase\": \"<current-phase>\", \"lastUpdated\": \"<ISO timestamp>\", \"errors\": [<any issues>]}.",
    "Keep state.json enriched with the workflow fields the canvas reads: clips[] (index, prompt, sourceType, quality, continuity, settings, status, localPath, posterPath, sourceUrl, duration), images[] (id, prompt, quality, localPath, sourceUrl, status), and finalVideo {localPath, clipIndices, builtAt} once assembled.",
    "When you pause or finish, append a short handoff note to memory.md so the next session can resume.",
    "All paths you read or write are relative to the instance folder unless absolute.",
  ].join(" "),
};

const blenderDefinition: WorkflowDefinition<BlenderState> = {
  type: "blender",
  label: "Blender Studio",
  icon: BlenderIcon,
  description: "Create 3D scenes and renders on an on-demand GPU instance.",
  folder: "blends",
  skill: "blender",
  Canvas: BlenderStudio,
  useState: useBlenderState,
  sessionPrompt: [
    "You are working in the Blender Studio workflow.",
    "GPU acquisition, release, and recovery are AUTOMATIC and owned by the host — do NOT call vast/ssh/destroy anything.",
    "For scene work (creating objects, materials, loading assets), use the `blender` MCP tools directly.",
    "There is ONE Blender process: your MCP tools and the user's 'Render' button share its single-threaded addon socket. NEVER run a Cycles render or large EEVEE render via MCP — it blocks the socket, times out the bridge, and corrupts scene.blend. Final renders are owned by the helper script (op:render), triggered by the user clicking 'Render' in the UI. When a render is running (state.json phase starting/rendering/recovering), do NOT call ANY blender tool — poll state.json + exports/render_*.png every ~15s and report when it finishes.",
    "Before reporting a scene change as done, verify it per the SKILL.md 'Verify your work' section: check mesh vertex/face counts via execute_code (a 0-vertex mesh is corrupted — rebuild it) and use vision analysis on the host-side preview file (the instance folder's exports/preview.png) to confirm the subject is framed and the render isn't blank before declaring success.",
    "The lease prefill tells you the current GPU state. If it is not 'ready', do NOT call blender tools yet — tell the user provisioning is underway.",
    "After any meaningful change: save via execute_code (bpy.ops.wm.save_as_mainfile(filepath=\"/root/blender/scene.blend\")), then do a quick EEVEE preview render (16 samples, 960x540) to /root/blender/renders/preview.png and update state.json renders[] with {id:\"preview\", path:\"exports/preview.png\", ...} so the user sees visual feedback immediately.",
    "Brand assets are at /root/assets/<filename> on the GPU instance (pushed during provisioning). Load with bpy.data.images.load('/root/assets/<filename>'). List them with execute_code: import os; print(os.listdir('/root/assets')). Never reference /workspace/brand/assets/ from Blender — that's on the host.",
    "Before acting, read memory.md and state.json in the instance folder if they exist, to pick up where a previous session left off.",
    "Keep state.json enriched with: scene {objectCount, engine, savedAt}, renders[] (id, label, path, thumbPath, engine, samples, createdAt).",
    "When you pause or finish, append a short handoff note to memory.md.",
    "All paths are relative to the instance folder unless absolute.",
  ].join(" "),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WORKFLOW_REGISTRY: Record<string, WorkflowDefinition<any>> = {
  carousel: carouselDefinition,
  video: videoDefinition,
  blender: blenderDefinition,
};

export type WorkflowType = keyof typeof WORKFLOW_REGISTRY;

/** All registered workflow types, in registry order. */
export const WORKFLOW_TYPES = Object.keys(WORKFLOW_REGISTRY) as WorkflowType[];

/** Convenience lookup with a typed fallback. */
export function getWorkflow(type: string): WorkflowDefinition | null {
  return (WORKFLOW_REGISTRY as Record<string, WorkflowDefinition>)[type] ?? null;
}
