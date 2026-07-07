import type { CanvasProps, WorkflowDefinition, WorkflowState } from "./types";

/**
 * The workflow registry. The shell reads this to render the rail and route
 * canvas components. Adding a workflow = adding one entry here plus dropping a
 * skill into container/skills/<type>/ — see
 * docs/superpowers/specs/2026-07-07-ai-os-shell-design.md Section 3.
 *
 * M2 NOTE: The carousel entry now uses a real useWorkspaceState<T>() poll and a
 * canvas that renders live phase from state.json. The full CarouselStudio
 * (slide preview, filmstrip, copy panel) lands in M3; this proves the
 * observation loop end-to-end.
 */

// ── Carousel state shape (canonical CarouselStudio version lands in M3) ────

interface CarouselState extends WorkflowState {
  files: Record<string, boolean>;
  exports: string[];
}

// ── Placeholder canvas (replaced by CarouselStudio in M3) ───────────────────
// Renders the live phase from state.json + lists discovered files, so we can
// verify the polling loop works before the real studio lands.

function CarouselPlaceholder({
  instanceId,
  state,
}: CanvasProps<CarouselState>) {
  const phase = state?.phase ?? "—";
  const errors = state?.errors ?? [];
  const files = state ? Object.keys(state.files) : [];
  const exports = state?.exports ?? [];
  const updated = state?.lastUpdated
    ? new Date(state.lastUpdated).toLocaleTimeString()
    : null;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="w-full max-w-md rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-6 py-8">
        <div className="flex items-center justify-center gap-2">
          <span className="grid h-2 w-2 place-items-center">
            <span
              className={
                "h-2 w-2 rounded-full " +
                (phase === "complete"
                  ? "bg-emerald-400"
                  : phase === "unknown" || phase === "—"
                    ? "bg-[var(--muted)]"
                    : "animate-pulse bg-indigo-400")
              }
            />
          </span>
          <p className="text-sm font-medium text-[var(--foreground)]">Carousel Studio</p>
        </div>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Instance <code className="font-mono">{instanceId.slice(0, 8)}</code> · phase:{" "}
          <code className="font-mono text-indigo-300">{phase}</code>
          {updated && <span className="ml-1">· updated {updated}</span>}
        </p>

        {files.length > 0 && (
          <div className="mt-4 text-left">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Workspace files
            </p>
            <ul className="flex flex-wrap gap-1">
              {files.map((f) => (
                <li
                  key={f}
                  className="rounded-md border border-white/10 bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]"
                >
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )}

        {exports.length > 0 && (
          <div className="mt-3 text-left">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Exports ({exports.length})
            </p>
            <div className="flex flex-wrap gap-1.5">
              {exports.map((e) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={e}
                  src={`/api/workspace/${instanceId}/file/${e}`}
                  alt={e}
                  className="h-14 w-14 rounded border border-white/10 object-cover"
                />
              ))}
            </div>
          </div>
        )}

        {errors.length > 0 && (
          <div className="mt-3 rounded-md bg-red-500/10 px-2 py-1.5 text-left text-[11px] text-red-300">
            {errors.join("; ")}
          </div>
        )}

        <p className="mt-4 text-[11px] text-[var(--muted)]">
          Full CarouselStudio UI lands in M3. Talk to the agent to drive this workflow.
        </p>
      </div>
    </div>
  );
}

function useCarouselState(instanceId: string, _folder: string) {
  // Wraps the generic polling hook. M3 will expand the parser to hydrate
  // slides[]/brief/etc.; for now we surface phase + files + exports.
  // (folder is unused today; reserved for workflows that need the absolute path
  // client-side — e.g. to construct deep file URLs without a server round-trip.)
  return useWorkspaceStateImport(instanceId);
}

// Indirect import keeps the placeholder module self-contained while avoiding a
// circular type dependency at module-eval time.
import { useWorkspaceState } from "@/lib/hooks/useWorkspaceState";
function useWorkspaceStateImport(instanceId: string) {
  return useWorkspaceState<CarouselState>(instanceId, {
    intervalMs: 2500,
    parse: (raw) => ({
      phase: raw.phase,
      lastUpdated: raw.lastUpdated,
      errors: raw.errors ?? [],
      files: raw.files ?? {},
      exports: raw.exports ?? [],
    }),
  });
}

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
  Canvas: CarouselPlaceholder,
  useState: useCarouselState,
  sessionPrompt: [
    "You are working in the Carousel Studio workflow.",
    "Before acting, read memory.md and state.json in the instance folder if they exist, to pick up where a previous session left off.",
    "When you reach a meaningful milestone (starting a phase, finishing a step, hitting an error), update state.json with at least: {\"phase\": \"<current-phase>\", \"lastUpdated\": \"<ISO timestamp>\", \"errors\": [<any issues>]}.",
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
