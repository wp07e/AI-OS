"use client";

import { useCallback, useEffect, useState } from "react";
import { AgentPanel } from "./AgentPanel";
import { WorkRail } from "./WorkRail";
import { PhasePill } from "./PhasePill";
import { getWorkflow } from "@/lib/workflows/registry";
import type { WorkflowState } from "@/lib/workflows/types";
import { useAgentChat } from "@/lib/hooks/useAgentChat";
import { AgentChatContext } from "@/lib/hooks/AgentChatContext";

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
  const [loadingInstances, setLoadingInstances] = useState(true);

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

  const active = instances.find((i) => i.id === activeId) ?? null;

  // One chat per active lane. Keyed on the active instance id; the hook resets
  // visible history on lane switch. Provided via context so any canvas can
  // trigger templated messages (chat-trigger buttons) without going through the
  // CanvasProps contract.
  const chat = useAgentChat(active?.id ?? null);

  return (
    <AgentChatContext.Provider value={chat}>
      <div className="grid flex-1 grid-cols-[240px_1fr_380px] overflow-hidden">
        <WorkRail
          instances={instances}
          activeId={activeId}
          onSelect={setActiveId}
          onRefresh={refreshInstances}
          loading={loadingInstances}
        />

        <section className="flex min-w-0 flex-col overflow-hidden border-x border-white/10">
          {active ? <CanvasArea instance={active} /> : <EmptyCanvas />}
        </section>

        <AgentPanel
          workflowInstanceId={active?.id ?? null}
          workflowType={active?.workflow_type ?? null}
        />
      </div>
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
function CanvasArea({ instance }: { instance: WorkflowInstance }) {
  const def = getWorkflow(instance.workflow_type);
  if (!def) {
    return <UnknownWorkflow type={instance.workflow_type} />;
  }

  const result = def.useState(instance.id, instance.folder);

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
  const phase = (result.state as WorkflowState | null)?.phase ?? "unknown";

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
