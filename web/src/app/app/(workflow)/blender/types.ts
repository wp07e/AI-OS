import type { WorkflowState } from "@/lib/workflows/types";

/**
 * Blender Studio state shape. The deterministic helper script
 * (`container/blender/run.py`) writes these fields into `state.json` as it
 * progresses; the canvas reads them via the generic
 * `/api/workspace/<id>/state` poll. The GPU lease state lives in the
 * `gpu_leases` DB table (read via `/api/workspace/<id>/blender/lease`), NOT in
 * state.json — see useBlenderState.
 */

/** The render engine. Cycles is the headless-safe default; EEVEE needs Xvfb. */
export type BlenderEngine = "CYCLES" | "BLENDER_EEVEE";

/** GPU lease states (mirrors LeaseState from lib/gpu/types.ts). */
export type LeaseState =
  | "none"
  | "queued"
  | "provisioning"
  | "ready"
  | "recovering"
  | "releasing"
  | "destroyed";

/** The GPU lease row, polled separately from state.json. */
export interface LeaseInfo {
  instance_id: string;
  state: LeaseState;
  gpu_name?: string | null;
  dph?: number | null;
  ssh_host?: string | null;
  ssh_port?: number | null;
  queue_position?: number | null;
  acquired_at?: number | null;
  last_activity?: number;
  last_synced_at?: number | null;
  /** Last error message (e.g. "vastai CLI not found", "no offers under cap"). */
  last_error?: string | null;
}

/** Scene metadata, written by the bootstrap op. */
export interface SceneInfo {
  objectCount?: number;
  engine?: BlenderEngine;
  savedAt?: string;
}

/** One render result. */
export interface RenderResult {
  id: string;
  label: string;
  /** Relative path, e.g. "exports/render_0001.png". */
  path: string;
  thumbPath: string;
  engine: string;
  samples: number;
  createdAt: string;
}

export interface BlenderState extends WorkflowState {
  /** The render/generation op currently in flight (for phase display). */
  active?: { op: string; label: string } | null;
  /** Scene metadata (object count, engine). */
  scene?: SceneInfo | null;
  /** Render results, newest first. */
  renders: RenderResult[];
  /** Files present in the instance folder (from the workspace listing). */
  files: Record<string, boolean>;
  /** Rendered exports, relative paths. */
  exports: string[];
}
