"use client";

import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import { getWorkflow, WORKFLOW_TYPES } from "@/lib/workflows/registry";
import { useCanvaStatus } from "./CanvaStatusProvider";
import type { WorkflowInstance } from "./AppShell";

interface Props {
  instances: WorkflowInstance[];
  activeId: string | null;
  /** Active library key ("brand") or null when a lane/empty is active. */
  activeLibrary: string | null;
  /** instanceId → true when a brand selection is applied (for the badge). */
  brandApplied: Record<string, boolean>;
  loading: boolean;
  onSelect: (id: string) => void;
  /** Selects a shared library view (clears the active lane). null = none. */
  onSelectLibrary: (key: string | null) => void;
  /** Opens the per-lane brand wizard for an instance. */
  onOpenBrandWizard: (inst: WorkflowInstance) => void;
  onRefresh: () => void;
}

/**
 * Left rail: lists workflow instances grouped by type (tool drawers), plus a
 * "+ New workflow" picker and a LIBRARIES section (stub for brand/templates).
 *
 * Drawer model: each workflow type is a collapsible drawer; opening it shows
 * that type's instances. Clicking an instance selects it in the shell.
 *
 * Workflows flagged `requiresCanva` are gated until the Canva MCP connects:
 * their create + open buttons are disabled and an inline note points at the
 * "Connect Canva" affordance in the header (see CanvaStatusProvider).
 */
export function WorkRail({ instances, activeId, activeLibrary, brandApplied, loading, onSelect, onSelectLibrary, onOpenBrandWizard, onRefresh }: Props) {
  const { connected, loading: canvaLoading } = useCanvaStatus();
  // Block only on a confirmed disconnect; while the probe is in flight the
  // buttons stay enabled so connected users never see a gate flicker.
  const canvaBlocked = !connected && !canvaLoading;

  const [openTypes, setOpenTypes] = useState<Set<string>>(new Set(["carousel"]));
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

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

  async function deleteWorkflow(inst: WorkflowInstance) {
    const confirmed = window.confirm(
      `Delete "${inst.title}"?\n\nThis removes the lane and all of its files. This cannot be undone.`,
    );
    if (!confirmed) return;
    setDeletingId(inst.id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(inst.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setDeleteError(data.error ?? `Failed (${res.status})`);
        return;
      }
      await onRefresh();
    } catch {
      setDeleteError("Network error deleting workflow.");
    } finally {
      setDeletingId(null);
    }
  }

  async function renameWorkflow(inst: WorkflowInstance, newTitle: string) {
    const trimmed = newTitle.trim().slice(0, 120);
    if (!trimmed || trimmed === inst.title) {
      setEditingId(null);
      return;
    }
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(inst.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        console.error("Rename failed:", data.error ?? res.status);
        return;
      }
      await onRefresh();
    } catch {
      console.error("Network error renaming workflow.");
    } finally {
      setEditingId(null);
    }
  }

  // Auto-focus the rename input when editing starts
  useEffect(() => {
    if (editingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [editingId]);

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
            const typeBlocked = def.requiresCanva && canvaBlocked;
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
                    {typeBlocked && (
                      <p className="px-2 py-1 text-[11px] leading-snug text-amber-300/80">
                        Requires Canva —{" "}
                        <Link href="/oauth" className="underline decoration-amber-300/40 underline-offset-2 hover:decoration-amber-300/80">
                          connect in the top bar
                        </Link>
                      </p>
                    )}
                    {instancesOfType.length === 0 ? (
                      <p className="px-2 py-1 text-xs text-[var(--muted)]">No items yet</p>
                    ) : (
                      instancesOfType.map((inst) => {
                        const blocked = typeBlocked;
                        return (
                          <div
                            key={inst.id}
                            className={
                              "group relative flex items-center rounded-md transition " +
                              (blocked ? "opacity-50" : "")
                            }
                          >
                            <button
                              onClick={() => {
                                if (blocked) return;
                                onSelect(inst.id);
                              }}
                              disabled={blocked}
                              className={
                                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition " +
                                (blocked
                                  ? "cursor-not-allowed text-[var(--muted)]"
                                  : inst.id === activeId
                                    ? "bg-indigo-500/15 text-indigo-200"
                                    : "text-[var(--foreground)]/80 hover:bg-white/5")
                              }
                            >
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" />
                              {editingId === inst.id ? (
                                <input
                                  ref={renameInputRef}
                                  value={editingTitle}
                                  onChange={(e) => setEditingTitle(e.target.value)}
                                  onBlur={() => renameWorkflow(inst, editingTitle)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      renameWorkflow(inst, editingTitle);
                                    } else if (e.key === "Escape") {
                                      setEditingId(null);
                                    }
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  className="flex-1 min-w-0 bg-transparent px-1 py-0 text-xs text-inherit outline-none ring-1 ring-indigo-500/50 rounded"
                                />
                              ) : (
                                <span
                                  className="flex-1 truncate pr-20 cursor-default"
                                  onDoubleClick={(e) => {
                                    e.stopPropagation();
                                    if (blocked) return;
                                    setEditingId(inst.id);
                                    setEditingTitle(inst.title);
                                  }}
                                >
                                  {inst.title}
                                </span>
                              )}
                            </button>
                            {!blocked && (
                              <>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenBrandWizard(inst);
                                  }}
                                  title="Brand for this carousel"
                                  aria-label={`Brand settings for ${inst.title}`}
                                  className={
                                    "absolute right-8 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded transition " +
                                    (brandApplied[inst.id]
                                      ? "opacity-100 text-indigo-300 hover:bg-indigo-500/15"
                                      : "text-[var(--muted)] opacity-100 hover:bg-white/5 hover:text-[var(--foreground)]")
                                  }
                                >
                                  <BrandSwatchIcon active={!!brandApplied[inst.id]} />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (deletingId !== null) return;
                                    deleteWorkflow(inst);
                                  }}
                                  disabled={deletingId !== null}
                                  title={
                                    deletingId === inst.id
                                      ? "Deleting…"
                                      : `Delete "${inst.title}"`
                                  }
                                  aria-label={`Delete ${inst.title}`}
                                  className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-[var(--muted)] opacity-100 transition hover:bg-red-500/15 hover:text-red-300 disabled:cursor-wait"
                                >
                                  {deletingId === inst.id ? (
                                    <SpinnerIcon />
                                  ) : (
                                    <TrashIcon />
                                  )}
                                </button>
                              </>
                            )}
                          </div>
                        );
                      })
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
            const blocked = def.requiresCanva && canvaBlocked;
            return (
              <button
                key={type}
                onClick={() => {
                  if (blocked) return;
                  createWorkflow(type);
                }}
                disabled={creating || blocked}
                title={blocked ? "Connect Canva first" : `New ${def.label}`}
                className={
                  "flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs transition hover:bg-white/[0.07] disabled:opacity-50 " +
                  (blocked ? "cursor-not-allowed" : "")
                }
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
        {deleteError && (
          <p className="rounded-md bg-red-500/10 px-2 py-1 text-[10px] text-red-300">{deleteError}</p>
        )}
      </div>

      <div className="border-t border-white/10 px-3 py-3">
        <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          Libraries
        </p>
        <div className="mt-1 flex flex-col gap-0.5">
          <button
            onClick={() => onSelectLibrary("brand")}
            className={
              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition " +
              (activeLibrary === "brand"
                ? "bg-indigo-500/15 text-indigo-200"
                : "text-[var(--foreground)]/80 hover:bg-white/5")
            }
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

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

/** Palette/swatch icon for the per-lane brand button. Filled when a selection
 *  is applied (badge effect), outlined otherwise. */
function BrandSwatchIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.43-.18-.83-.44-1.12-.29-.29-.44-.65-.44-1.12a1.64 1.64 0 0 1 1.67-1.67H16c3.05 0 5.55-2.5 5.55-5.55C22 6 17.5 2 12 2z" />
      <circle cx="7.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="11.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="animate-spin" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
