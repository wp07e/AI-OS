import type { ComponentType } from "react";

/**
 * The per-workflow state shape. Each workflow defines its own by extending this.
 * The shell never inspects the workflow-specific fields; it just passes state
 * through to the canvas.
 *
 * The three required fields are the only contract the shell relies on:
 *  - phase:        a progress signal shown in shell chrome
 *  - lastUpdated:  ISO timestamp; canvas uses it for staleness checks
 *  - errors:       human-readable strings surfaced in shell chrome
 */
export interface WorkflowState {
  phase: string;
  lastUpdated: string;
  errors: string[];
  [key: string]: unknown;
}

/**
 * Props every canvas receives. The shell constructs these and passes them in.
 * The canvas owns 100% of what it renders inside the center pane.
 */
export interface CanvasProps<S extends WorkflowState> {
  instanceId: string;
  folder: string;
  state: S;
}

/**
 * Result shape returned by a workflow's `useState` hook. The generic
 * `useWorkspaceState<T>()` helper (added in M2) returns this; in the meantime
 * workflows can construct it directly.
 */
export interface UseWorkspaceStateResult<S> {
  state: S | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
}

/**
 * A workflow definition. Implement this and register it in WORKFLOW_REGISTRY.
 *
 * The shell's only coupling to a workflow is this object — it renders
 * `<def.Canvas state={def.useState(...)} />` inside the center pane and nothing
 * more. What the canvas renders (toolbar, previews, editors) is entirely the
 * workflow's business.
 *
 * See docs/superpowers/specs/2026-07-07-ai-os-shell-design.md Section 3 for
 * the full developer guide.
 */
export interface WorkflowDefinition<S extends WorkflowState = WorkflowState> {
  /* ── 1. IDENTITY (rail + routing) ──────────────────────────────── */
  /** Unique workflow type id, e.g. 'carousel'. */
  readonly type: string;
  /** Display label shown in the rail and "+ New workflow" picker. */
  readonly label: string;
  /** Rail icon component. */
  readonly icon: ComponentType<{ className?: string }>;
  /** Optional one-liner shown in the "+ New workflow" picker. */
  readonly description?: string;

  /* ── 2. WORKSPACE (filesystem layout) ─────────────────────────── */
  /** Subfolder under /workspace where instances live, e.g. 'carousels'. */
  readonly folder: string;
  /** OpenCode skill name the agent should load for this workflow. */
  readonly skill: string;

  /* ── 3. CANVAS (the pluggable UI — 100% workflow-owned) ───────── */
  readonly Canvas: ComponentType<CanvasProps<S>>;

  /* ── 4. STATE OBSERVATION ─────────────────────────────────────── */
  /** Hook the shell calls to observe the workflow's workspace state. */
  readonly useState: (instanceId: string, folder: string) => UseWorkspaceStateResult<S>;

  /* ── 5. SESSION PRIMING (optional) ────────────────────────────── */
  /** Prepended when a lane session is created. */
  readonly sessionPrompt?: string;
}
