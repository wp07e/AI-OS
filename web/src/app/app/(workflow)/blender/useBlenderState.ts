"use client";

import { useCallback, useEffect, useState } from "react";
import { useWorkspaceState } from "@/lib/hooks/useWorkspaceState";
import type { BlenderState, LeaseInfo, RenderResult } from "./types";

/**
 * Blender Studio state observer. Wraps the generic focus-aware poller with a
 * parser that hydrates the workflow-specific fields (scene, renders). Returns
 * the standard UseWorkspaceStateResult shape (used by the registry's useState).
 */
export function useBlenderState(instanceId: string, folder: string) {
  void folder; // reserved by the contract; unused today
  return useWorkspaceState<BlenderState>(instanceId, {
    intervalMs: 2500,
    parse: (raw) => ({
      phase: raw.phase,
      lastUpdated: raw.lastUpdated,
      errors: raw.errors ?? [],
      active: parseActive(raw.active),
      scene: parseScene(raw.scene),
      renders: parseRenders(raw.renders),
      files: raw.files ?? {},
      exports: raw.exports ?? [],
    }),
  });
}

/**
 * GPU lease state poller. Polled SEPARATELY from state.json because the lease
 * state lives in the gpu_leases DB table, not the workspace. The GET also
 * bumps last_activity on the server (idle-timeout reset while the user views
 * the lane).
 *
 * While the lease is booting (provisioning/recovering), the GET also returns
 * `bootLogs` — a tail of the GPU instance's provisioning output — so the UI
 * can show live progress instead of a static "Booting" pill.
 */
export function useBlenderLease(instanceId: string) {
  const [lease, setLease] = useState<LeaseInfo | null>(null);
  const [bootLogs, setBootLogs] = useState<string | undefined>(undefined);
  // Whether the first GET has resolved. The lane-open auto-acquire effect must
  // NOT fire until the lease state is actually loaded — otherwise a remount
  // (lane switch back, StrictMode, HMR) would see lease=null and fire acquire
  // before we know whether the GPU was manually released.
  const [loaded, setLoaded] = useState(false);

  // Pending manual release, backed by sessionStorage so it SURVIVES the lane
  // unmount/remount that happens on every navigation away-and-back. Without
  // this, after clicking "Release GPU" and navigating away, a remount poll could
  // briefly read `ready` (before the server's releasing write lands, or during
  // lock contention) and re-render the "Release GPU" button as if nothing had
  // happened. The flag is set on click (markReleasing) and cleared once the
  // poller observes a terminal state (destroyed/none).
  const RELEASING_KEY = `blender:releasing:${instanceId}`;
  const [isReleasingPending, setIsReleasingPending] = useState(false);

  // Read the persisted flag on mount (and when instanceId changes).
  useEffect(() => {
    try {
      setIsReleasingPending(sessionStorage.getItem(RELEASING_KEY) === "1");
    } catch {
      setIsReleasingPending(false);
    }
  }, [RELEASING_KEY]);

  const markReleasing = useCallback(() => {
    try {
      sessionStorage.setItem(RELEASING_KEY, "1");
    } catch {
      // sessionStorage unavailable (private mode, etc.) — the in-memory flag
      // still covers the current mount.
    }
    setIsReleasingPending(true);
  }, [RELEASING_KEY]);

  // Clear the flag once the server confirms a terminal state. The poller below
  // updates `lease.state`, which this effect watches.
  useEffect(() => {
    if (lease && (lease.state === "destroyed" || lease.state === "none")) {
      setIsReleasingPending(false);
      try {
        sessionStorage.removeItem(RELEASING_KEY);
      } catch {
        // ignore
      }
    }
  }, [lease, RELEASING_KEY]);

  const refreshLease = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspace/${instanceId}/blender/lease`, { method: "GET" });
      if (res.ok) {
        const data = await res.json();
        setLease(data.lease ?? null);
        setBootLogs(data.bootLogs);
      }
    } catch {
      // network blip — keep last-known lease
    }
  }, [instanceId]);

  useEffect(() => {
    // Initial fetch + polling interval. The fetch is async so setState happens
    // in the .then() callback (not synchronously in the effect body), matching
    // the existing video/brand polling pattern.
    let active = true;
    let consecutiveErrors = 0;
    const poll = async () => {
      try {
        const res = await fetch(`/api/workspace/${instanceId}/blender/lease`, { method: "GET" });
        if (active && res.ok) {
          const data = await res.json();
          setLease(data.lease ?? null);
          setBootLogs(data.bootLogs);
          setLoaded(true);
          consecutiveErrors = 0;
        }
      } catch {
        // Network blip: tolerate a few failures, but after 3 consecutive
        // errors (~15s at 5s poll), clear the stale lease so the UI doesn't
        // show "GPU Ready" indefinitely when the server is unreachable.
        consecutiveErrors++;
        if (active && consecutiveErrors >= 3) {
          setLease((prev) =>
            prev && prev.state !== "none"
              ? { ...prev, state: "none" as const, last_error: "Connection lost — retrying…" }
              : prev,
          );
        }
      }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [instanceId]);

  return { lease, bootLogs, loaded, refreshLease, isReleasingPending, markReleasing };
}

function parseActive(raw: unknown): BlenderState["active"] {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const op = typeof a.op === "string" ? a.op : undefined;
  const label = typeof a.label === "string" ? a.label : undefined;
  if (!op && !label) return null;
  return { op: op ?? "", label: label ?? "" };
}

function parseScene(raw: unknown): BlenderState["scene"] {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  return {
    objectCount: typeof s.objectCount === "number" ? s.objectCount : undefined,
    engine: s.engine === "CYCLES" || s.engine === "BLENDER_EEVEE" || s.engine === "BLENDER_EEVEE_NEXT" ? s.engine : undefined,
    savedAt: typeof s.savedAt === "string" ? s.savedAt : undefined,
  };
}

function parseRenders(raw: unknown): RenderResult[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): RenderResult | null => {
      if (!entry || typeof entry !== "object") return null;
      const r = entry as Record<string, unknown>;
      const id = typeof r.id === "string" ? r.id : `render-${Date.now()}`;
      return {
        id,
        label: typeof r.label === "string" ? r.label : "Render",
        path: typeof r.path === "string" ? r.path : "",
        thumbPath: typeof r.thumbPath === "string" ? r.thumbPath : "",
        engine: typeof r.engine === "string" ? r.engine : "CYCLES",
        samples: typeof r.samples === "number" ? r.samples : 0,
        createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
      };
    })
    .filter((r): r is RenderResult => r !== null && r.path !== "");
}
