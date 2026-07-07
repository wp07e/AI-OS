"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  UseWorkspaceStateResult,
  WorkflowState,
} from "@/lib/workflows/types";

interface RawWorkspaceResponse {
  phase: string;
  lastUpdated: string;
  errors: string[];
  files?: Record<string, boolean>;
  exports?: string[];
  folder: string;
  instanceId: string;
  [key: string]: unknown;
}

interface UseWorkspaceStateOptions<S extends WorkflowState> {
  /** Polling interval in milliseconds. Default 2500. */
  intervalMs?: number;
  /**
   * Parses the raw API response into the workflow's typed state. Workflows use
   * this to hydrate nested fields (slides[], sections[], etc.) with defaults.
   * Receives the raw object plus convenience fields (files, exports).
   */
  parse: (
    raw: RawWorkspaceResponse,
  ) => S;
}

/**
 * Generic workspace-state polling hook. Every workflow's `useState` wraps this.
 *
 * Polls GET /api/workspace/<instanceId>/state on an interval, parsing each
 * response via the workflow's `parse` function into a typed WorkflowState.
 * Behaviors:
 *   - Pauses polling when the tab is hidden (focus-aware) to avoid wasted load.
 *   - Polls immediately on mount and on focus return.
 *   - Exposes `refresh()` for manual re-fetch after a user action.
 *   - Tolerates network/parse errors: keeps the last good state, sets `error`.
 *
 * The shell calls this hook indirectly through a workflow's
 * WorkflowDefinition.useState; workflows shouldn't call it directly from canvas
 * code (the shell owns the lifecycle).
 */
export function useWorkspaceState<S extends WorkflowState>(
  instanceId: string | null,
  options: UseWorkspaceStateOptions<S>,
): UseWorkspaceStateResult<S> {
  const { intervalMs = 2500, parse } = options;
  const [state, setState] = useState<S | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const parseRef = useRef(parse);
  parseRef.current = parse;

  const refresh = useCallback(async () => {
    if (!instanceId) {
      setState(null);
      setIsLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/workspace/${instanceId}/state`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`/api/workspace/${instanceId}/state → ${res.status}`);
      }
      const raw = (await res.json()) as RawWorkspaceResponse;
      const parsed = parseRef.current(raw);
      setState(parsed);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setIsLoading(false);
    }
  }, [instanceId]);

  // Poll on interval, focus-aware.
  useEffect(() => {
    if (!instanceId) {
      setState(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    refresh();

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(refresh, intervalMs);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        refresh(); // catch up immediately on focus return
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [instanceId, intervalMs, refresh]);

  return { state, isLoading, error, refresh };
}
