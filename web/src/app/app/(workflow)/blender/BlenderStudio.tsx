"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  const { lease, bootLogs, loaded, refreshLease, isReleasingPending, markReleasing } = useBlenderLease(instanceId);
  const chat = useAgentChatContext();

  // ── Auto-acquire on lane open (no user action) ───────────────────────────
  useEffect(() => {
    // Wait until the lease state has actually been loaded. On a remount (lane
    // switch back, StrictMode, HMR) `lease` is null on the first render; without
    // this gate the effect would fire acquire before we know whether the GPU was
    // manually released.
    if (!loaded) return;
    // Do NOT auto-acquire if the user explicitly released the GPU. After a
    // "Release GPU" click the lease row persists as state="destroyed" +
    // manually_released=1; the only way back is the explicit "Acquire GPU"
    // button. Without this guard, returning to the lane would silently spin up
    // a new GPU the user just released.
    if (lease?.manually_released) return;
    if (lease?.state && lease.state !== "none" && lease.state !== "destroyed") return;
    // Fire the auto-acquire. resume:true so a saved .blend is pushed up.
    fetch(`/api/workspace/${instanceId}/blender/lease`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resume: true }),
    }).then(() => refreshLease()).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, loaded]);

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

  // Crossfade the viewport preview when a new render arrives. The previous
  // <img> remounted on every `version` bump (key included version), leaving a
  // black gap while the new bytes loaded. Now we keep a stable element and
  // fade the fresh image in only once its network fetch completes, so the old
  // pixels stay visible throughout the swap.
  const [imgLoaded, setImgLoaded] = useState(false);
  const lastSrcRef = useRef<string | null>(null);
  const previewSrc = latestRender
    ? `/api/workspace/${instanceId}/file/${latestRender.path}?v=${version ?? ""}`
    : null;
  useEffect(() => {
    // When src changes (new render or version bump), hide until loaded.
    if (previewSrc !== lastSrcRef.current) {
      lastSrcRef.current = previewSrc;
      setImgLoaded(false);
    }
  }, [previewSrc]);

  const handleRelease = async () => {
    // Set the pending-release flag synchronously BEFORE the fetch. This makes
    // the "Releasing…" button survive a lane unmount/remount (navigation away
    // and back) during the release window, covering the brief period before the
    // server's `releasing` write is observable by the poller.
    markReleasing();
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

  // "Retry now" while queued: force an immediate market probe for this lane
  // (bypassing the 20s queue-pump cadence) so the user isn't stuck waiting on
  // the next tick when they can see the market may have changed.
  const handleRetryQueued = async () => {
    await fetch(`/api/workspace/${instanceId}/blender/lease`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry" }),
    });
    refreshLease();
  };

  return (
    <div className="flex h-full">
      {/* ── Main area: pill + viewport + gallery ─────────────────────────── */}
      <div className="flex-1 flex flex-col gap-3 p-4 overflow-hidden">
        <LeasePill
          lease={lease}
          bootLogs={bootLogs}
          loaded={loaded}
          pendingRelease={isReleasingPending}
          onRelease={handleRelease}
          onAcquire={handleAcquire}
          onRetry={handleRetryQueued}
        />

        {/* Viewport preview */}
        <div className="flex-1 flex items-center justify-center bg-black/40 rounded-lg border border-white/10 overflow-hidden min-h-0 relative">
          {latestRender ? (
            <>
              <img
                key={latestRender.path}
                src={previewSrc ?? ""}
                alt={latestRender.label}
                onLoad={() => setImgLoaded(true)}
                className={`max-w-full max-h-full object-contain transition-opacity duration-200 ${
                  imgLoaded ? "opacity-100" : "opacity-0"
                }`}
              />
              {/* Download the current render. Mirrors the video workflow's
                  Download ↓ affordance (VideoStudio.tsx). */}
              <a
                href={`/api/workspace/${instanceId}/file/${latestRender.path}?v=${version ?? ""}`}
                download
                className="absolute right-3 top-3 rounded-lg border border-white/10 bg-black/60 px-2.5 py-1 text-[10px] font-semibold text-white backdrop-blur transition hover:bg-black/80"
                title="Download this render"
              >
                Download ↓
              </a>
            </>
          ) : (
            <EmptyState leaseReady={leaseReady} manuallyReleased={!!lease?.manually_released} busy={busy} phase={phase} />
          )}
        </div>

        {/* Render gallery (filmstrip) */}
        {renders.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {renders.map((r) => (
              <a
                key={r.id}
                href={`/api/workspace/${instanceId}/file/${r.path}?v=${version ?? r.createdAt}`}
                download
                rel="noreferrer"
                className="flex-shrink-0 w-20 h-20 rounded border border-white/10 overflow-hidden hover:border-white/30 transition-colors"
                title={`Download ${r.label}`}
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
  manuallyReleased,
  busy,
  phase,
}: {
  leaseReady: boolean;
  manuallyReleased: boolean;
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
    if (manuallyReleased) {
      // The user explicitly released the GPU — nothing will work until they
      // click "Acquire GPU". Don't imply it's being acquired automatically.
      return (
        <div className="text-center text-white/40 max-w-xs">
          <p className="text-sm mb-1">GPU has been released.</p>
          <p className="text-xs text-white/30">
            Rendering and scene editing are unavailable until you click <span className="text-emerald-400/80">Acquire GPU</span> above.
          </p>
        </div>
      );
    }
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
