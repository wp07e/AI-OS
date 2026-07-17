"use client";

import { useCallback, useEffect, useState } from "react";
import { AgentPanel } from "./AgentPanel";
import { WorkRail } from "./WorkRail";
import { PhasePill } from "./PhasePill";
import { BrandStudio } from "../(library)/brand/BrandStudio";
import { BrandWizard } from "../(workflow)/carousel/BrandWizard";
import { AutomationWizard } from "../(workflow)/video/AutomationWizard";
import { getWorkflow } from "@/lib/workflows/registry";
import type { WorkflowState } from "@/lib/workflows/types";
import { useAgentChat, type ChatTransport } from "@/lib/hooks/useAgentChat";
import { AgentChatContext } from "@/lib/hooks/AgentChatContext";
import { GenerationBusyContext, type GenerationBusyValue } from "@/lib/hooks/GenerationBusyContext";
import type { BrandCardKey } from "@/lib/brand/cards";

/**
 * Workflow instance row (mirrors the workflow_instances table shape; fetched
 * from /api/workflows).
 */
export interface WorkflowInstance {
  id: string;
  workflow_type: string;
  title: string;
  folder: string;
  status: string;
}

/**
 * Top-level layout for the AI OS app once a user has a ready container.
 * Three panes:
 *   - left rail (WorkRail): lists workflow instances + "+ New workflow"
 *   - center canvas: renders the active workflow's Canvas component
 *   - right agent panel (AgentPanel): persistent chat for the active lane
 *
 * The shell owns "which workflow instance is active" — switching instances
 * re-targets both the canvas and the agent panel to that lane.
 */
export function AppShell() {
  const [instances, setInstances] = useState<WorkflowInstance[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeLibrary, setActiveLibrary] = useState<string | null>(null);
  const [loadingInstances, setLoadingInstances] = useState(true);
  // Set by the active video canvas when a background generation script is
  // running, so the AgentPanel can disable chat to prevent interference.
  const [generationBusy, setGenerationBusy] = useState<GenerationBusyValue>({ busy: false });
  // Instance ids currently being deleted. Owned here (not in WorkRail) so the
  // active lane's chat input can be disabled while its deletion is in flight.
  // Per-lane: concurrent deletes of different lanes are allowed.
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const refreshInstances = useCallback(async () => {
    try {
      const res = await fetch("/api/workflows", { method: "GET" });
      const data = (await res.json().catch(() => ({}))) as { instances?: WorkflowInstance[] };
      const list = data.instances ?? [];
      setInstances(list);
      // Keep the active selection if it still exists; otherwise fall back to the
      // first. This handles deletions (the active lane going away) and any other
      // external mutation that removes the selected instance.
      setActiveId((current) =>
        current && list.some((i) => i.id === current) ? current : list[0]?.id ?? null,
      );
    } catch {
      // Non-fatal: rail will just show empty state.
    } finally {
      setLoadingInstances(false);
    }
  }, []);

  // Fetch the workflow instances on mount (and whenever refreshInstances is
  // refreshed from elsewhere). The setState calls happen after an await, so they
  // don't cause synchronous cascading renders — this is the external-system-sync
  // case the rule is meant to permit.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshInstances();
  }, [refreshInstances]);

  // Per-lane brand-selection state: which lanes have a brand applied (for the
  // WorkRail badge), and which lane's wizard is open. Refreshed after the
  // wizard saves so badges update live.
  const [brandApplied, setBrandApplied] = useState<Record<string, boolean>>({});
  const [brandWizardInstance, setBrandWizardInstance] = useState<WorkflowInstance | null>(null);
  const [automationWizardInstance, setAutomationWizardInstance] = useState<WorkflowInstance | null>(null);

  const refreshBrandApplied = useCallback(async () => {
    try {
      // One request per instance is fine for the MVP instance counts; each just
      // reads a small JSON from the container.
      const results = await Promise.all(
        instances.map(async (inst) => {
          const res = await fetch(`/api/workflows/${inst.id}/brand-selection`, {
            cache: "no-store",
          });
          if (!res.ok) return [inst.id, false] as const;
          const data = (await res.json()) as { selection: { enabled: boolean } };
          return [inst.id, !!data.selection?.enabled] as const;
        }),
      );
      setBrandApplied(Object.fromEntries(results));
    } catch {
      // Non-fatal — badges just won't show.
    }
  }, [instances]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshBrandApplied();
  }, [refreshBrandApplied]);

  const active = instances.find((i) => i.id === activeId) ?? null;

  // Selecting a lane or a library is mutually exclusive: only one center-pane
  // view is active at a time. Each handler clears the other so the UI never
  // shows two "active" selections. Switching away from Brand also deactivates
  // the brand AI panel (it's invite-only — re-activated by clicking Ask AI).
  const [aiActivated, setAiActivated] = useState(false);
  const [activeBrandCard, setActiveBrandCard] = useState<BrandCardKey | null>(null);

  const selectInstance = useCallback((id: string) => {
    setActiveLibrary(null);
    setActiveId(id);
    setAiActivated(false);
    // Auto-close the brand wizard on lane switch so a stale A-context modal
    // never lingers over a newly-selected lane B.
    setBrandWizardInstance(null);
  }, []);
  const selectLibrary = useCallback((key: string | null) => {
    if (key) setActiveId(null);
    setActiveLibrary(key);
    setAiActivated(false);
    setBrandWizardInstance(null);
  }, []);

  // The agent chat targets either a workflow lane or the brand library. The
  // session key uniquely identifies the chat context (so each keeps its own
  // history); the transport tells the server how to address it. For brand, the
  // transport also carries the open card so the server can scope the agent.
  const sessionKey = activeLibrary === "brand"
    ? "brand"
    : active ? `lane:${active.id}` : null;
  const transport: ChatTransport | null = activeLibrary === "brand"
    ? { key: "library", value: "brand", card: activeBrandCard ?? undefined }
    : active ? { key: "workflowInstanceId", value: active.id } : null;
  const chat = useAgentChat(sessionKey, transport);

  // Ask AI on a brand card: activate the panel (no input seeding — the user
  // types or clicks an example chip). The card context reaches the agent via
  // the hidden server-side preamble, not via a visible message.
  const handleAskAI = useCallback((card: BrandCardKey) => {
    setActiveBrandCard(card);
    setAiActivated(true);
  }, []);

  // When the open card changes, keep the transport's card context in sync.
  // Going back to the grid (card → null) also clears the brand chat and
  // deactivates the panel, so the next card's Ask AI starts fresh (new examples,
  // new per-card preamble, no stale history).
  const handleBrandCardChange = useCallback((card: BrandCardKey | null) => {
    setActiveBrandCard(card);
    if (card === null) {
      chat.clearSession("brand");
      setAiActivated(false);
    }
  }, [chat]);

  return (
    <AgentChatContext.Provider value={chat}>
      <GenerationBusyContext.Provider value={generationBusy}>
        <div className="grid flex-1 grid-cols-[240px_1fr_380px] overflow-hidden">
        <WorkRail
          instances={instances}
          activeId={activeId}
          activeLibrary={activeLibrary}
          brandApplied={brandApplied}
          onSelect={selectInstance}
          onSelectLibrary={selectLibrary}
          onOpenBrandWizard={(inst) => setBrandWizardInstance(inst)}
          onOpenAutomationWizard={(inst) => setAutomationWizardInstance(inst)}
          onRefresh={refreshInstances}
          loading={loadingInstances}
          deletingIds={deletingIds}
          setDeletingIds={setDeletingIds}
        />

        <section className="flex min-w-0 flex-col overflow-hidden border-x border-white/10">
          {activeLibrary === "brand" ? (
            <BrandStudio onAskAI={handleAskAI} onCardChange={handleBrandCardChange} />
          ) : active ? (
            <CanvasArea instance={active} onGenerationBusyChange={setGenerationBusy} />
          ) : (
            <EmptyCanvas />
          )}
        </section>

        <AgentPanel
          workflowInstanceId={active?.id ?? null}
          workflowType={active?.workflow_type ?? null}
          activeLibrary={activeLibrary}
          activeBrandCard={activeBrandCard}
          aiActivated={aiActivated}
          laneDeleting={active ? deletingIds.has(active.id) : false}
        />
        </div>

        {/* Per-lane brand wizard modal. Rendered at the shell level so it overlays
            whatever center pane is active (lane stays visible underneath). */}
        {brandWizardInstance && (
          <BrandWizard
            instanceId={brandWizardInstance.id}
            onClose={() => setBrandWizardInstance(null)}
            onSaved={() => {
              refreshBrandApplied();
            }}
          />
        )}

        {/* Per-lane automation wizard modal (video lanes only). Same shell-level
            overlay pattern as the brand wizard. */}
        {automationWizardInstance && (
          <AutomationWizard
            instanceId={automationWizardInstance.id}
            onClose={() => setAutomationWizardInstance(null)}
          />
        )}
      </GenerationBusyContext.Provider>
    </AgentChatContext.Provider>
  );
}

/**
 * Renders the active workflow's Canvas component with state from its useState
 * hook, plus a shell chrome sub-header (instance title + phase pill) and
 * loading/error states. Kept as its own component so the hook calls follow the
 * Rules of Hooks unconditionally per active instance (the canvas mounts/unmounts
 * as the user switches lanes, which correctly resets polling + state).
 */
function CanvasArea({
  instance,
  onGenerationBusyChange,
}: {
  instance: WorkflowInstance;
  onGenerationBusyChange: (v: GenerationBusyValue) => void;
}) {
  const def = getWorkflow(instance.workflow_type);

  // Hooks must run unconditionally (rules of hooks). For unknown workflow types,
  // def is null — we pass empty values and bail to UnknownWorkflow below.
  const result = def
    ? def.useState(instance.id, instance.folder)
    : { state: null, isLoading: false, error: null, refresh: () => {} };

  const phase = (result?.state as WorkflowState | null)?.phase ?? "unknown";

  // Signal generation-busy to the shell so the AgentPanel can disable chat
  // during background script runs (video + carousel workflows). Covers both
  // video phases (starting/preparing/generating/...) and carousel phases
  // (planning/generating_design/...). "starting" is written by the routes
  // immediately to bridge the gap before the script's first state write.
  // Note: the initial carousel generation flows through the agent chat and is
  // already gated by chat.busy; these carousel phases mainly cover the
  // select-candidate resume path (fire-and-forget, like video).
  const isGenBusy =
    // Shared / video phases
    phase === "starting" ||
    phase === "preparing" ||
    phase === "generating" ||
    phase === "downloading" ||
    phase === "assembling" ||
    phase === "automating" ||
    // Carousel phases (resume path + agent-driven)
    phase === "planning" ||
    phase === "generating_design" ||
    phase === "resolving_assets" ||
    phase === "assets_resolved" ||
    phase === "capturing_template" ||
    phase === "template_captured" ||
    phase === "awaiting_candidate_selection" ||
    // Blender phases (GPU provisioning + rendering + recovery)
    phase === "provisioning" ||
    phase === "rendering" ||
    phase === "recovering";
  useEffect(() => {
    onGenerationBusyChange(
      isGenBusy
        ? { busy: true, reason: "Generation in progress — chat paused to avoid conflicts." }
        : { busy: false },
    );
  }, [isGenBusy, onGenerationBusyChange]);

  if (!def || !result) {
    return <UnknownWorkflow type={instance.workflow_type} />;
  }

  // Loading: first poll hasn't completed yet. Show a skeleton instead of
  // passing null state to the canvas (which would render an empty-looking
  // studio). Once we have any state — even a stale one — we render the canvas;
  // it handles partial/missing fields gracefully via ?? defaults.
  if (result.isLoading && !result.state) {
    return <LoadingSkeleton label={def.label} title={instance.title} />;
  }

  // Error with no state to fall back on: show a retry UI. If we have a prior
  // good state, keep showing it (the hook retains last-good state on error).
  if (result.error && !result.state) {
    return <CanvasError error={result.error} onRetry={result.refresh} title={instance.title} />;
  }

  const Canvas = def.Canvas;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Shell chrome sub-header: persistent across all workflows. */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-[var(--card)]/40 px-4 py-2">
        <h2 className="truncate text-xs font-semibold text-[var(--foreground)]">{instance.title}</h2>
        <PhasePill phase={phase} />
      </div>
      {/* Workflow-owned canvas. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <Canvas instanceId={instance.id} folder={instance.folder} state={result.state as WorkflowState} />
      </div>
    </div>
  );
}

function LoadingSkeleton({ label, title }: { label: string; title: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-[var(--card)]/40 px-4 py-2">
        <span className="text-xs font-semibold text-[var(--muted)]">{title}</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] font-medium text-[var(--muted)]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--muted)]" />
          Loading…
        </span>
      </div>
      <div className="flex flex-1 items-center justify-center p-10">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/10 border-t-indigo-400" />
          <p className="text-xs text-[var(--muted)]">Loading {label}…</p>
        </div>
      </div>
    </div>
  );
}

function CanvasError({ error, onRetry, title }: { error: Error; onRetry: () => void; title: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-[var(--card)]/40 px-4 py-2">
        <span className="text-xs font-semibold text-[var(--muted)]">{title}</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-red-400/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-300">
          <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
          Error
        </span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
        <p className="text-sm font-medium">Couldn&apos;t load workflow state</p>
        <p className="max-w-sm text-xs text-[var(--muted)]">
          {error.message || "The state file could not be read or parsed."}
        </p>
        <button
          onClick={onRetry}
          className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2 text-xs font-semibold transition hover:bg-white/[0.06]"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function EmptyCanvas() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/[0.03]">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-[var(--muted)]"
          aria-hidden
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M9 21V9" />
        </svg>
      </div>
      <div>
        <p className="text-sm font-medium">No workflow selected</p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Pick a workflow on the left, or start a new one.
        </p>
      </div>
    </div>
  );
}

function UnknownWorkflow({ type }: { type: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-10 text-center">
      <p className="text-sm font-medium">Unknown workflow type</p>
      <p className="text-xs text-[var(--muted)]">
        <code className="font-mono">{type}</code> is not registered.
      </p>
    </div>
  );
}
