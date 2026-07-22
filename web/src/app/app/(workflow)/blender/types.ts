import type { WorkflowState } from "@/lib/workflows/types";

/**
 * Blender Studio state shape. The deterministic helper script
 * (`container/blender/run.py`) writes these fields into `state.json` as it
 * progresses; the canvas reads them via the generic
 * `/api/workspace/<id>/state` poll. The GPU lease state lives in the
 * `gpu_leases` DB table (read via `/api/workspace/<id>/blender/lease`), NOT in
 * state.json — see useBlenderState.
 */

/** The render engine. Cycles is the headless-safe default; EEVEE needs Xvfb.
 * Blender 4.2+ uses BLENDER_EEVEE_NEXT (the old BLENDER_EEVEE was removed). */
export type BlenderEngine = "CYCLES" | "BLENDER_EEVEE_NEXT" | "BLENDER_EEVEE";

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
  /** Combined inet_down+up cost in $/GB (usage-based Vast.ai Internet fee).
   *  Surfaced alongside dph so the pill shows both rate types. */
  inet_cost?: number | null;
  ssh_host?: string | null;
  ssh_port?: number | null;
  queue_position?: number | null;
  /** ms epoch of the last queue-pump market-search attempt (success or failure). */
  queue_last_checked_at?: number | null;
  /** null when the last market search succeeded (even if empty); set when the
   *  vastai CLI/auth/network threw. Distinct from last_error (which covers
   *  provisioning errors like "no qualifying GPU offers under cap"). */
  queue_search_error?: string | null;
  acquired_at?: number | null;
  last_activity?: number;
  last_synced_at?: number | null;
  /** Last error message (e.g. "vastai CLI not found", "no offers under cap",
   *  or the queue-timeout message). */
  last_error?: string | null;
  /**
   * 1 when the user explicitly released the GPU. While set, the frontend does
   * NOT auto-acquire on lane open — only an explicit "Acquire GPU" click clears
   * it. Mirrors LeaseRow.manually_released (see lib/gpu/lease-manager.ts).
   */
  manually_released?: number;
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
