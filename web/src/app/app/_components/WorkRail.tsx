"use client";

import { useState } from "react";
import { getWorkflow, WORKFLOW_TYPES } from "@/lib/workflows/registry";
import type { WorkflowInstance } from "./AppShell";

interface Props {
  instances: WorkflowInstance[];
  activeId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}

/**
 * Left rail: lists workflow instances grouped by type (tool drawers), plus a
 * "+ New workflow" picker and a LIBRARIES section (stub for brand/templates).
 *
 * Drawer model: each workflow type is a collapsible drawer; opening it shows
 * that type's instances. Clicking an instance selects it in the shell.
 */
export function WorkRail({ instances, activeId, loading, onSelect, onRefresh }: Props) {
  const [openTypes, setOpenTypes] = useState<Set<string>>(new Set(["carousel"]));
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function toggleType(type: string) {
    setOpenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  async function createWorkflow(type: string) {
    const def = getWorkflow(type);
    if (!def) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          // Default title; the agent/canvas can rename later. Keeps M1 simple.
          title: `New ${def?.label ?? type}`,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { instance?: WorkflowInstance; error?: string };
      if (!res.ok || !data.instance) {
        setCreateError(data.error ?? `Failed (${res.status})`);
        return;
      }
      await onRefresh();
      onSelect(data.instance.id);
    } catch {
      setCreateError("Network error creating workflow.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto border-r border-white/10 bg-[var(--card)]/30">
      <div className="px-3 py-3">
        <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          Work
        </p>
      </div>

      {loading ? (
        <div className="px-4 py-2 text-xs text-[var(--muted)]">Loading…</div>
      ) : (
        <nav className="flex flex-col gap-0.5 px-2">
          {WORKFLOW_TYPES.map((type) => {
            const def = getWorkflow(type);
            if (!def) return null;
            const instancesOfType = instances.filter((i) => i.workflow_type === type);
            const isOpen = openTypes.has(type);
            const Icon = def.icon;
            return (
              <div key={type}>
                <button
                  onClick={() => toggleType(type)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-white/5"
                >
                  <ChevronIcon open={isOpen} />
                  <Icon className="text-[var(--muted)]" />
                  <span className="flex-1 truncate">{def.label}</span>
                  {instancesOfType.length > 0 && (
                    <span className="text-[10px] text-[var(--muted)]">{instancesOfType.length}</span>
                  )}
                </button>

                {isOpen && (
                  <div className="ml-6 flex flex-col gap-0.5 border-l border-white/10 pl-2">
                    {instancesOfType.length === 0 ? (
                      <p className="px-2 py-1 text-xs text-[var(--muted)]">No items yet</p>
                    ) : (
                      instancesOfType.map((inst) => (
                        <button
                          key={inst.id}
                          onClick={() => onSelect(inst.id)}
                          className={
                            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition " +
                            (inst.id === activeId
                              ? "bg-indigo-500/15 text-indigo-200"
                              : "text-[var(--foreground)]/80 hover:bg-white/5")
                          }
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />
                          <span className="flex-1 truncate">{inst.title}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      )}

      <div className="mt-auto flex flex-col gap-2 p-3">
        <div className="flex flex-wrap gap-1.5">
          {WORKFLOW_TYPES.map((type) => {
            const def = getWorkflow(type);
            if (!def) return null;
            const Icon = def.icon;
            return (
              <button
                key={type}
                onClick={() => createWorkflow(type)}
                disabled={creating}
                title={`New ${def.label}`}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs transition hover:bg-white/[0.07] disabled:opacity-50"
              >
                <Icon className="text-[var(--muted)]" />
                <span>{def.label}</span>
              </button>
            );
          })}
        </div>
        <p className="text-[10px] uppercase tracking-wider text-[var(--muted)]">+ New workflow</p>
        {createError && (
          <p className="rounded-md bg-red-500/10 px-2 py-1 text-[10px] text-red-300">{createError}</p>
        )}
      </div>

      <div className="border-t border-white/10 px-3 py-3">
        <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          Libraries
        </p>
        <div className="mt-1 flex flex-col gap-0.5">
          <button
            disabled
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-[var(--muted)] opacity-50"
          >
            <BrandIcon />
            <span>Brand</span>
          </button>
          <button
            disabled
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-[var(--muted)] opacity-50"
          >
            <TemplateIcon />
            <span>Templates</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden
      className={"text-[var(--muted)] transition-transform " + (open ? "rotate-90" : "")}
    >
      <path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BrandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </svg>
  );
}

function TemplateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
