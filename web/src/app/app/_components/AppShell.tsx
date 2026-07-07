"use client";

import { useCallback, useEffect, useState } from "react";
import { AgentPanel } from "./AgentPanel";
import { WorkRail } from "./WorkRail";
import { getWorkflow } from "@/lib/workflows/registry";
import type { WorkflowState } from "@/lib/workflows/types";

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
      // Keep an active selection if possible; otherwise default to the first.
      setActiveId((current) => current ?? list[0]?.id ?? null);
    } catch {
      // Non-fatal: rail will just show empty state.
    } finally {
      setLoadingInstances(false);
    }
  }, []);

  useEffect(() => {
    refreshInstances();
  }, [refreshInstances]);

  const active = instances.find((i) => i.id === activeId) ?? null;

  return (
    <div className="grid flex-1 grid-cols-[240px_1fr_380px] overflow-hidden">
      <WorkRail
        instances={instances}
        activeId={activeId}
        onSelect={setActiveId}
        onRefresh={refreshInstances}
        loading={loadingInstances}
      />

      <section className="flex min-w-0 flex-col overflow-hidden border-x border-white/10">
        {active ? <WorkflowCanvas instance={active} /> : <EmptyCanvas />}
      </section>

      <AgentPanel workflowInstanceId={active?.id ?? null} workflowType={active?.workflow_type ?? null} />
    </div>
  );
}

/**
 * Renders the active workflow's Canvas component with state from its useState
 * hook. Kept as its own component so the hook calls follow the Rules of Hooks
 * unconditionally per active instance (the canvas mounts/unmounts as the user
 * switches lanes, which correctly resets polling + state).
 */
function WorkflowCanvas({ instance }: { instance: WorkflowInstance }) {
  const def = getWorkflow(instance.workflow_type);
  if (!def) {
    return <UnknownWorkflow type={instance.workflow_type} />;
  }

  const Canvas = def.Canvas;
  const result = def.useState(instance.id, instance.folder);
  return <Canvas instanceId={instance.id} folder={instance.folder} state={result.state as WorkflowState} />;
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
