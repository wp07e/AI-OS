"use client";

import { useState } from "react";
import type { BlenderEngine, LeaseInfo } from "./types";

/**
 * The render settings panel (right side of the canvas). Posts to the render
 * route, which launches the deterministic Blender render script. Disabled until
 * the GPU lease is "ready".
 *
 * Modeled on the video GeneratePanel — a direct form POST (fire-and-forget),
 * not through chat.
 */
export function RenderPanel({
  instanceId,
  lease,
  busy,
}: {
  instanceId: string;
  lease: LeaseInfo | null;
  busy: boolean;
}) {
  const [engine, setEngine] = useState<BlenderEngine>("CYCLES");
  const [samples, setSamples] = useState(128);
  const [resolution, setResolution] = useState("1080p");
  const [frameStart, setFrameStart] = useState(1);
  const [frameEnd, setFrameEnd] = useState(1);
  const [submitting, setSubmitting] = useState(false);

  const leaseReady = lease?.state === "ready";
  const disabled = !leaseReady || busy || submitting;

  const handleSubmit = async () => {
    if (disabled) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/workspace/${instanceId}/blender/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { engine, samples, resolution, frame_start: frameStart, frame_end: frameEnd },
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Render failed: ${err.error ?? res.statusText}`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <h3 className="text-sm font-semibold text-white/80 uppercase tracking-wide">Render</h3>

      {!leaseReady && (
        <p className="text-xs text-amber-400/80">
          {lease?.manually_released
            ? "GPU released — click Acquire GPU above to continue."
            : lease?.state === "queued"
              ? "Waiting for a GPU…"
              : lease?.state === "provisioning" || lease?.state === "recovering"
                ? "GPU is coming up…"
                : "Acquiring GPU…"}
          {!lease?.manually_released && " Rendering will be available once the GPU is ready."}
        </p>
      )}

      <Field label="Engine">
        <select
          value={engine}
          onChange={(e) => setEngine(e.target.value as BlenderEngine)}
          disabled={disabled}
          className="w-full bg-white/[0.05] border border-white/10 rounded px-2 py-1.5 text-sm text-white/90"
        >
          <option value="CYCLES">Cycles (GPU, photorealistic)</option>
          <option value="BLENDER_EEVEE_NEXT">EEVEE (real-time, faster)</option>
        </select>
      </Field>

      <Field label="Samples">
        <select
          value={samples}
          onChange={(e) => setSamples(Number(e.target.value))}
          disabled={disabled}
          className="w-full bg-white/[0.05] border border-white/10 rounded px-2 py-1.5 text-sm text-white/90"
        >
          <option value={64}>64 (draft)</option>
          <option value={128}>128 (standard)</option>
          <option value={256}>256 (high)</option>
          <option value={512}>512 (final)</option>
          <option value={1024}>1024 (ultra)</option>
        </select>
      </Field>

      <Field label="Resolution">
        <select
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          disabled={disabled}
          className="w-full bg-white/[0.05] border border-white/10 rounded px-2 py-1.5 text-sm text-white/90"
        >
          <option value="720p">720p</option>
          <option value="1080p">1080p</option>
          <option value="1440p">1440p</option>
          <option value="4k">4K</option>
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Frame start">
          <input
            type="number"
            min={1}
            value={frameStart}
            onChange={(e) => setFrameStart(Math.max(1, Number(e.target.value) || 1))}
            disabled={disabled}
            className="w-full bg-white/[0.05] border border-white/10 rounded px-2 py-1.5 text-sm text-white/90"
          />
        </Field>
        <Field label="Frame end">
          <input
            type="number"
            min={frameStart}
            value={frameEnd}
            onChange={(e) => setFrameEnd(Math.max(frameStart, Number(e.target.value) || frameStart))}
            disabled={disabled}
            className="w-full bg-white/[0.05] border border-white/10 rounded px-2 py-1.5 text-sm text-white/90"
          />
        </Field>
      </div>

      <button
        onClick={handleSubmit}
        disabled={disabled}
        className="mt-2 px-4 py-2 rounded-md bg-indigo-500/80 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {submitting ? "Starting…" : busy ? "Working…" : "Render"}
      </button>

      <p className="text-xs text-white/40 mt-1">
        Use the chat panel for natural-language scene work — e.g. &quot;add a red cube&quot;,
        &quot;apply brushed metal&quot;, &quot;load a Poly Haven HDRI&quot;.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-white/50">{label}</span>
      {children}
    </label>
  );
}
