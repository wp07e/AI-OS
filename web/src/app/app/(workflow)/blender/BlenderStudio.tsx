"use client";

import { useEffect, useMemo } from "react";
import type { CanvasProps } from "@/lib/workflows/types";
import { useAgentChatContext } from "@/lib/hooks/AgentChatContext";
import { useBlenderLease } from "./useBlenderState";
import { LeasePill } from "./LeasePill";
import { RenderPanel } from "./RenderPanel";
import type { BlenderState } from "./types";

/**
 * The Blender Studio canvas. Registered in WORKFLOW_REGISTRY as type "blender".
 *
 * Layout: a lease status pill + viewport preview + render gallery in the main
 * area, and a render settings panel on the right. Natural-language scene work
 * flows through the agent chat panel (the agent uses the blender MCP tools
 * directly); final renders go through the deterministic render route.
 *
 * GPU acquisition is AUTOMATIC: the lane-open effect POSTs to the lease
 * endpoint (no user action). The lease is auto-released on idle-timeout /
 * lane-leave. See container/skills/blender/SKILL.md and
 * web/src/lib/gpu/lease-manager.ts.
 */
export function BlenderStudio({ instanceId, state }: CanvasProps<BlenderState>) {
  const { lease, bootLogs, refreshLease } = useBlenderLease(instanceId);
  const chat = useAgentChatContext();

  // ── Auto-acquire on lane open (no user action) ───────────────────────────
  useEffect(() => {
    if (lease?.state && lease.state !== "none" && lease.state !== "destroyed") return;
    // Fire the auto-acquire. resume:true so a saved .blend is pushed up.
    fetch(`/api/workspace/${instanceId}/blender/lease`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resume: true }),
    }).then(() => refreshLease()).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  // NOTE: the lease is NOT released on React unmount. Doing so caused premature
  // releases because unmount fires on every lane switch (and on StrictMode's
  // dev double-mount), destroying the GPU mid-provision. Instead, cleanup is
  // handled by the idle reaper (GPU_IDLE_TIMEOUT_MS, default 10 min) and the
  // manual "Release GPU" button in LeasePill. See lease-manager.ts.

  const phase = state?.phase ?? "unknown";
  const renders = useMemo(() => state?.renders ?? [], [state?.renders]);
  const version = state?.lastUpdated;
  const busy = isBusy(phase) || chat.busy;
  const leaseReady = lease?.state === "ready";
  const latestRender = renders[0] ?? null;

  const handleRelease = async () => {
    await fetch(`/api/workspace/${instanceId}/blender/lease`, { method: "DELETE" });
    refreshLease();
  };

  const handleAcquire = async () => {
    await fetch(`/api/workspace/${instanceId}/blender/lease`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resume: true }),
    });
    refreshLease();
  };

  return (
    <div className="flex h-full">
      {/* ── Main area: pill + viewport + gallery ─────────────────────────── */}
      <div className="flex-1 flex flex-col gap-3 p-4 overflow-hidden">
        <LeasePill lease={lease} bootLogs={bootLogs} onRelease={handleRelease} onAcquire={handleAcquire} />

        {/* Viewport preview */}
        <div className="flex-1 flex items-center justify-center bg-black/40 rounded-lg border border-white/10 overflow-hidden min-h-0">
          {latestRender ? (
            <img
              key={latestRender.path + version}
              src={`/api/workspace/${instanceId}/file/${latestRender.path}?v=${version ?? ""}`}
              alt={latestRender.label}
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <EmptyState leaseReady={leaseReady} busy={busy} phase={phase} />
          )}
        </div>

        {/* Render gallery (filmstrip) */}
        {renders.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {renders.map((r) => (
              <a
                key={r.id}
                href={`/api/workspace/${instanceId}/file/${r.path}?v=${version ?? r.createdAt}`}
                target="_blank"
                rel="noreferrer"
                className="flex-shrink-0 w-20 h-20 rounded border border-white/10 overflow-hidden hover:border-white/30 transition-colors"
                title={r.label}
              >
                <img
                  src={`/api/workspace/${instanceId}/file/${r.thumbPath}?v=${version ?? r.createdAt}`}
                  alt={r.label}
                  className="w-full h-full object-cover"
                />
              </a>
            ))}
          </div>
        )}
      </div>

      {/* ── Right panel: render settings ─────────────────────────────────── */}
      <div className="w-[320px] border-l border-white/10 bg-white/[0.02] overflow-y-auto">
        <RenderPanel instanceId={instanceId} lease={lease} busy={busy} />
      </div>
    </div>
  );
}

function EmptyState({
  leaseReady,
  busy,
  phase,
}: {
  leaseReady: boolean;
  busy: boolean;
  phase: string;
}) {
  if (isStale(phase)) {
    return (
      <div className="text-center text-white/40 max-w-xs">
        <p className="text-sm mb-1">Render state appears stale.</p>
        <p className="text-xs text-white/30">
          The last render didn&apos;t finish — the GPU may have been lost. Try again once the GPU is ready.
        </p>
      </div>
    );
  }
  if (busy) {
    return (
      <div className="text-center text-white/40">
        <div className="inline-block w-6 h-6 border-2 border-white/20 border-t-white/60 rounded-full animate-spin mb-3" />
        <p className="text-sm">{phase === "starting" ? "Starting…" : "Working…"}</p>
      </div>
    );
  }
  if (!leaseReady) {
    return (
      <div className="text-center text-white/40 max-w-xs">
        <p className="text-sm mb-1">GPU is being acquired automatically.</p>
        <p className="text-xs text-white/30">
          You can start describing your scene in the chat panel — it will apply once the GPU is ready.
        </p>
      </div>
    );
  }
  return (
    <div className="text-center text-white/40 max-w-xs">
      <p className="text-sm mb-1">No renders yet.</p>
      <p className="text-xs text-white/30">
        Describe your scene in the chat panel (e.g. &quot;a red cube on a plane&quot;) or adjust render
        settings and click Render.
      </p>
    </div>
  );
}

/** Phases that indicate the script is actively working (disables chat + form). */
function isBusy(phase: string): boolean {
  return (
    phase === "starting" ||
    phase === "provisioning" ||
    phase === "rendering" ||
    phase === "recovering"
  );
}

/** Phases that indicate the workflow state is stale (process likely dead). */
function isStale(phase: string): boolean {
  return phase === "stale";
}
