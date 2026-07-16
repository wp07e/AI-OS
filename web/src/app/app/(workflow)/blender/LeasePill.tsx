"use client";

import { useState } from "react";
import type { LeaseInfo } from "./types";

/**
 * The GPU lease status pill. Shown at the top of the Blender canvas.
 *
 * Acquisition is AUTOMATIC (fires on lane open) — there is no "Acquire" button.
 * This component is status-only, plus an optional "Release GPU now" for users
 * who want to stop billing early. Idle-timeout and lane-leave auto-release
 * handle the normal case.
 */
export function LeasePill({
  lease,
  bootLogs,
  onRelease,
  onAcquire,
}: {
  lease: LeaseInfo | null;
  bootLogs?: string;
  onRelease: () => void;
  onAcquire: () => void;
}) {
  const [releasing, setReleasing] = useState(false);
  const [acquiring, setAcquiring] = useState(false);
  const state = lease?.state ?? "none";

  const handleRelease = async () => {
    setReleasing(true);
    try {
      await onRelease();
    } finally {
      setReleasing(false);
    }
  };

  const handleAcquire = async () => {
    setAcquiring(true);
    try {
      await onAcquire();
    } finally {
      setAcquiring(false);
    }
  };

  const { label, color, detail } = describeLease(lease);
  const error = lease?.last_error;
  // Show the boot panel (spinner or logs) whenever the lease is booting —
  // bootLogs may be undefined until the instance's container exists.
  const isBooting = state === "provisioning" || state === "recovering";
  // Show "Acquire GPU" only when there's no active lease (released/destroyed).
  const canAcquire = state === "none" || state === "destroyed";

  return (
    <div className="flex flex-col gap-1 px-3 py-1.5 rounded-md bg-white/[0.03] border border-white/10 text-sm">
      <div className="flex items-center gap-3">
        <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
        <span className="font-medium text-white/90">{label}</span>
        {detail && <span className="text-white/50">{detail}</span>}
        {(state === "ready" || state === "recovering") && (
          <button
            onClick={handleRelease}
            disabled={releasing}
            className="ml-auto text-xs text-white/50 hover:text-white/80 transition-colors disabled:opacity-40"
            title="Release the GPU now (stop billing). Click Acquire GPU to start a new one."
          >
            {releasing ? "Releasing…" : "Release GPU"}
          </button>
        )}
        {canAcquire && (
          <button
            onClick={handleAcquire}
            disabled={acquiring}
            className="ml-auto text-xs text-emerald-400/80 hover:text-emerald-300 transition-colors disabled:opacity-40"
            title="Acquire a new GPU instance."
          >
            {acquiring ? "Acquiring…" : "Acquire GPU"}
          </button>
        )}
      </div>
      {isBooting && (
        <div className="mt-1 px-3 py-1.5 rounded bg-black/40 border border-white/5 overflow-x-auto max-h-32 overflow-y-auto">
          {bootLogs ? (
            <pre className="text-[11px] leading-tight text-white/50 font-mono whitespace-pre-wrap break-all">
              {bootLogs}
            </pre>
          ) : (
            <div className="flex items-center gap-2 text-[11px] text-white/40">
              <span className="inline-block w-3 h-3 border border-white/20 border-t-white/50 rounded-full animate-spin" />
              <span>Waiting for instance to boot…</span>
            </div>
          )}
        </div>
      )}
      {error && (
        <div className="text-xs text-red-400/80 pl-5">
          {error}
        </div>
      )}
    </div>
  );
}

function describeLease(lease: LeaseInfo | null): {
  label: string;
  color: string;
  detail?: string;
} {
  if (!lease || lease.state === "none") {
    return { label: "No GPU", color: "bg-white/30" };
  }
  switch (lease.state) {
    case "queued":
      return {
        label: "Waiting for GPU",
        color: "bg-amber-400 animate-pulse",
        detail: lease.queue_position != null ? `#${lease.queue_position + 1} in queue` : undefined,
      };
    case "provisioning":
      return {
        label: "Starting GPU",
        color: "bg-blue-400 animate-pulse",
        detail: lease.gpu_name ? `(${lease.gpu_name})` : "1–5 min",
      };
    case "recovering":
      return {
        label: "Reconnecting GPU",
        color: "bg-amber-400 animate-pulse",
        detail: "instance restarted",
      };
    case "ready":
      return {
        label: "GPU Ready",
        color: "bg-emerald-400",
        detail: [lease.gpu_name, lease.dph ? `$${lease.dph.toFixed(3)}/hr` : null]
          .filter(Boolean)
          .join(" • "),
      };
    case "releasing":
      return { label: "Releasing GPU", color: "bg-white/40 animate-pulse" };
    case "destroyed":
      return { label: "GPU Released", color: "bg-white/30" };
    default:
      return { label: "GPU", color: "bg-white/30" };
  }
}
