"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

interface CanvaStatus {
  /** True once the probe resolves; false while the first fetch is in flight. */
  loading: boolean;
  /** Whether the Canva MCP is connected. False until confirmed otherwise. */
  connected: boolean;
  /** Re-probe the connection (e.g. after returning from /oauth). */
  refresh: () => void;
  /** Force-connected to false immediately (e.g. on 401 detection), then
   *  re-probe after a short delay to allow automatic recovery if the token
   *  was refreshed in the background. */
  invalidateCanva: () => void;
}

const CanvaStatusContext = createContext<CanvaStatus>({
  loading: true,
  connected: false,
  refresh: () => {},
  invalidateCanva: () => {},
});

/**
 * Provides a single Canva-connection probe to the app shell. Rendered in
 * app/layout.tsx so the header (Connect Canva affordance) and the rail
 * (lane gating) share one fetch.
 *
 * Gate logic across the app treats a lane as blocked only when
 * `!connected && !loading` — a confirmed disconnect — so a connected user
 * never sees a gate flicker on load, and a disconnected user's brief
 * enabled→disabled flip is backstopped by the server-side create gate.
 */
export function CanvaStatusProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);

  const probe = useCallback(async () => {
    try {
      const res = await fetch("/api/canva/status", { method: "GET" });
      const data = (await res.json().catch(() => ({}))) as { connected?: boolean };
      setConnected(data.connected === true);
    } catch {
      setConnected(false);
    } finally {
      setLoading(false);
    }
  }, []);

  /** Immediately mark disconnected, then re-probe after 2 s so the UI
   *  recovers automatically if the token was refreshed in the background. */
  const invalidateCanva = useCallback(() => {
    setConnected(false);
    setTimeout(probe, 2000);
  }, [probe]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    probe();
  }, [probe]);

  return (
    <CanvaStatusContext.Provider value={{ loading, connected, refresh: probe, invalidateCanva }}>
      {children}
    </CanvaStatusContext.Provider>
  );
}

export function useCanvaStatus(): CanvaStatus {
  return useContext(CanvaStatusContext);
}
