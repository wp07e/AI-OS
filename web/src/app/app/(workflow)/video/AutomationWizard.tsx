"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrandAsset } from "@/lib/brand/types";
import type { Quality, Continuity } from "./types";
import { useBrandKit, useLaneBrandAssets, useUploads, uploadReference, fileUrl, thumbUrl, estimateVideoCost } from "./lib";

interface Props {
  instanceId: string;
  onClose: () => void;
}

type Step = "overview" | "clips" | "review";
const STEP_ORDER: Step[] = ["overview", "clips", "review"];
const STEP_LABELS: Record<Step, string> = {
  overview: "Overview",
  clips: "Clips",
  review: "Review",
};

type AssetMode = "brand" | "ai" | "upload";

interface ClipConfig {
  continuity: Continuity;
  assetMode: AssetMode;
  brandAssets: string[];
  uploadedAssets: string[];
  promptHint: string;
}

function emptyClipConfig(index: number): ClipConfig {
  return {
    continuity: index === 0 ? "none" : "last_frame",
    assetMode: "brand",
    brandAssets: [],
    uploadedAssets: [],
    promptHint: "",
  };
}

/**
 * Automation wizard for video lanes. A 3-step modal that collects the full
 * video specification upfront (clip count, durations, resolution, per-clip
 * assets, base story), then submits it to the automate API route which writes
 * automation_request.json and triggers the agent.
 *
 * After submission, the wizard closes — the automation runs in the background
 * and clips appear in VideoStudio as they complete (polled via state.json).
 *
 * Shell-level overlay mounted like BrandWizard (AppShell owns the instance
 * state and renders this modal on top of whatever center pane is active).
 */
export function AutomationWizard({ instanceId, onClose }: Props) {
  const [step, setStep] = useState<Step>("overview");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1: Overview settings
  const [clipCount, setClipCount] = useState(3);
  const [clipDuration, setClipDuration] = useState(6);
  const [resolution, setResolution] = useState("720p");
  const [quality, setQuality] = useState<Quality>("low");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [baseStory, setBaseStory] = useState("");

  // Step 2: Per-clip configs
  const [clipConfigs, setClipConfigs] = useState<ClipConfig[]>([]);

  // Brand kit + lane selection + uploads (shared with the ReferenceGrid pattern)
  const { kit, loading: kitLoading } = useBrandKit();
  const { assets: laneAssets } = useLaneBrandAssets(instanceId, kit);
  const { uploads, refresh: refreshUploads } = useUploads(instanceId);

  // Sync clipConfigs array length with clipCount
  useEffect(() => {
    setClipConfigs((prev) => {
      const next = [...prev];
      while (next.length < clipCount) next.push(emptyClipConfig(next.length));
      while (next.length > clipCount) next.pop();
      return next;
    });
  }, [clipCount]);

  const patchClip = useCallback((index: number, patch: Partial<ClipConfig>) => {
    setClipConfigs((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    );
  }, []);

  const applyToAll = useCallback(() => {
    if (clipConfigs.length === 0) return;
    const template = clipConfigs[0];
    setClipConfigs((prev) =>
      prev.map((c, i) =>
        i === 0 ? c : { ...template, continuity: "last_frame" as Continuity },
      ),
    );
  }, [clipConfigs]);

  async function handleGenerate() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspace/${instanceId}/video/automate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clipCount,
          clipDuration,
          resolution,
          quality,
          aspectRatio,
          baseStory,
          clips: clipConfigs.map((c, i) => ({
            index: i,
            continuity: c.continuity,
            assetMode: c.assetMode,
            brandAssets: c.brandAssets,
            uploadedAssets: c.uploadedAssets,
            promptHint: c.promptHint,
          })),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const stepIndex = STEP_ORDER.indexOf(step);
  const totalCost = useMemo(() => {
    return estimateVideoCost(quality, resolution, clipDuration, quality === "high");
  }, [quality, resolution, clipDuration]);
  const estMinutes = useMemo(() => {
    // Rough: ~1.5 min per clip for low, ~3 min for high
    const perClip = quality === "high" ? 3 : 1.5;
    return Math.ceil(clipCount * perClip);
  }, [clipCount, quality]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[var(--card)] shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3">
          <div className="flex items-center gap-2">
            <SparkleHeaderIcon />
            <h2 className="text-sm font-semibold text-[var(--foreground)]">Video Automation</h2>
          </div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-[var(--muted)] transition hover:bg-white/5 hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex shrink-0 items-center gap-1 border-b border-white/10 px-5 py-2">
          {STEP_ORDER.map((s, i) => (
            <button
              key={s}
              onClick={() => i < stepIndex + 1 && setStep(s)}
              disabled={i > stepIndex}
              className={
                "rounded-md px-2.5 py-1 text-[11px] font-medium transition " +
                (s === step
                  ? "bg-indigo-500/15 text-indigo-200"
                  : i < stepIndex
                    ? "text-[var(--muted)] hover:bg-white/5"
                    : "text-[var(--muted)]/40 cursor-not-allowed")
              }
            >
              {i + 1}. {STEP_LABELS[s]}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {step === "overview" && (
            <OverviewStep
              clipCount={clipCount}
              setClipCount={setClipCount}
              clipDuration={clipDuration}
              setClipDuration={setClipDuration}
              resolution={resolution}
              setResolution={setResolution}
              quality={quality}
              setQuality={setQuality}
              aspectRatio={aspectRatio}
              setAspectRatio={setAspectRatio}
              baseStory={baseStory}
              setBaseStory={setBaseStory}
              estMinutes={estMinutes}
              totalCost={totalCost}
            />
          )}
          {step === "clips" && (
            <ClipsStep
              clipConfigs={clipConfigs}
              patchClip={patchClip}
              applyToAll={applyToAll}
              laneAssets={laneAssets}
              uploads={uploads}
              instanceId={instanceId}
              onUploaded={refreshUploads}
              kitLoading={kitLoading}
            />
          )}
          {step === "review" && (
            <ReviewStep
              clipCount={clipCount}
              clipDuration={clipDuration}
              resolution={resolution}
              quality={quality}
              aspectRatio={aspectRatio}
              baseStory={baseStory}
              clipConfigs={clipConfigs}
              estMinutes={estMinutes}
              totalCost={totalCost}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between border-t border-white/10 px-5 py-3">
          <div className="flex gap-2">
            {stepIndex > 0 && (
              <button
                onClick={() => setStep(STEP_ORDER[stepIndex - 1])}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-[var(--muted)] transition hover:bg-white/5"
              >
                Back
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {error && <span className="text-[10px] text-red-300">{error}</span>}
            {stepIndex < STEP_ORDER.length - 1 ? (
              <button
                onClick={() => setStep(STEP_ORDER[stepIndex + 1])}
                className="rounded-lg bg-indigo-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-600"
              >
                Next
              </button>
            ) : (
              <button
                onClick={handleGenerate}
                disabled={submitting}
                className="rounded-lg bg-indigo-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-600 disabled:opacity-50"
              >
                {submitting ? "Starting…" : "Generate ✨"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Step components ─────────────────────────────────────────────────────────

function OverviewStep(props: {
  clipCount: number;
  setClipCount: (n: number) => void;
  clipDuration: number;
  setClipDuration: (n: number) => void;
  resolution: string;
  setResolution: (s: string) => void;
  quality: Quality;
  setQuality: (q: Quality) => void;
  aspectRatio: string;
  setAspectRatio: (s: string) => void;
  baseStory: string;
  setBaseStory: (s: string) => void;
  estMinutes: number;
  totalCost: string;
}) {
  const { clipCount, setClipCount, clipDuration, setClipDuration, resolution, setResolution,
    quality, setQuality, aspectRatio, setAspectRatio, baseStory, setBaseStory, estMinutes, totalCost } = props;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1 block text-[11px] font-medium text-[var(--foreground)]">
          Number of clips: <span className="text-indigo-300">{clipCount}</span>
        </label>
        <input type="range" min={1} max={10} value={clipCount}
          onChange={(e) => setClipCount(Number(e.target.value))}
          className="w-full accent-indigo-500" />
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-medium text-[var(--foreground)]">
          Duration per clip: <span className="text-indigo-300">{clipDuration}s</span>
        </label>
        <input type="range" min={1} max={15} value={clipDuration}
          onChange={(e) => setClipDuration(Number(e.target.value))}
          className="w-full accent-indigo-500" />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="mb-1 block text-[10px] uppercase tracking-wider text-[var(--muted)]">Resolution</label>
          <select value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-[var(--card)] px-2 py-1.5 text-xs text-[var(--foreground)]">
            <option value="480p">480p</option>
            <option value="720p">720p</option>
            {quality === "high" && <option value="1080p">1080p</option>}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[10px] uppercase tracking-wider text-[var(--muted)]">Quality</label>
          <select value={quality}
            onChange={(e) => setQuality(e.target.value as Quality)}
            className="w-full rounded-lg border border-white/10 bg-[var(--card)] px-2 py-1.5 text-xs text-[var(--foreground)]">
            <option value="low">Low (faster)</option>
            <option value="high">High (better)</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[10px] uppercase tracking-wider text-[var(--muted)]">Aspect</label>
          <select value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-[var(--card)] px-2 py-1.5 text-xs text-[var(--foreground)]">
            <option value="16:9">16:9 Landscape</option>
            <option value="9:16">9:16 Portrait</option>
            <option value="1:1">1:1 Square</option>
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-medium text-[var(--foreground)]">
          Base story (optional)
        </label>
        <textarea value={baseStory}
          onChange={(e) => setBaseStory(e.target.value)}
          placeholder="e.g. Funny talking characters in a coffee shop, or leave blank for AI to decide"
          rows={3}
          className="w-full rounded-lg border border-white/10 bg-[var(--card)] px-3 py-2 text-xs text-[var(--foreground)] placeholder:text-[var(--muted)]/50" />
        <p className="mt-1 text-[10px] text-[var(--muted)]">
          The AI will use this as a guide for the overall narrative. Each clip gets its own prompt based on this.
        </p>
      </div>

      <div className="rounded-lg border border-indigo-400/20 bg-indigo-500/[0.04] px-3 py-2 text-[11px] text-indigo-200/80">
        ⏱ Estimated time: ~{estMinutes} minutes · 💰 {totalCost} per clip
        <br />
        <span className="text-[10px] text-[var(--muted)]">
          You can close this wizard after starting — progress is saved and clips appear in the studio as they complete.
        </span>
      </div>
    </div>
  );
}

function ClipsStep(props: {
  clipConfigs: ClipConfig[];
  patchClip: (index: number, patch: Partial<ClipConfig>) => void;
  applyToAll: () => void;
  laneAssets: BrandAsset[];
  uploads: { path: string; filename: string }[];
  instanceId: string;
  onUploaded: () => void;
  kitLoading: boolean;
}) {
  const { clipConfigs, patchClip, applyToAll, laneAssets, uploads, instanceId, onUploaded, kitLoading } = props;

  if (kitLoading) {
    return <div className="py-8 text-center text-xs text-[var(--muted)]">Loading brand assets…</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-[var(--muted)]">
          Configure each clip. Brand assets come from this lane&apos;s Brand wizard. Uploads are one-time images for this video only.
        </p>
        <button onClick={applyToAll}
          className="shrink-0 rounded-lg border border-white/10 px-2 py-1 text-[10px] text-[var(--muted)] transition hover:bg-white/5">
          Apply clip 1 to all
        </button>
      </div>

      {clipConfigs.map((config, i) => (
        <ClipCard
          key={i}
          index={i}
          config={config}
          patch={(p) => patchClip(i, p)}
          laneAssets={laneAssets}
          uploads={uploads}
          instanceId={instanceId}
          onUploaded={onUploaded}
        />
      ))}
    </div>
  );
}

function ClipCard(props: {
  index: number;
  config: ClipConfig;
  patch: (p: Partial<ClipConfig>) => void;
  laneAssets: BrandAsset[];
  uploads: { path: string; filename: string }[];
  instanceId: string;
  onUploaded: () => void;
}) {
  const { index, config, patch, laneAssets, uploads, instanceId, onUploaded } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const selectedSet = new Set([...config.brandAssets, ...config.uploadedAssets]);

  const toggleAsset = (id: string) => {
    const isBrand = laneAssets.some((a) => a.id === id);
    if (isBrand) {
      const current = new Set(config.brandAssets);
      if (current.has(id)) current.delete(id);
      else current.add(id);
      patch({ brandAssets: [...current] });
    } else {
      const current = new Set(config.uploadedAssets);
      if (current.has(id)) current.delete(id);
      else current.add(id);
      patch({ uploadedAssets: [...current] });
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const result = await uploadReference(instanceId, file);
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    if (result) onUploaded();
  };

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-indigo-500/20 text-[10px] font-bold text-indigo-300">
          {index + 1}
        </span>
        <span className="text-xs font-medium text-[var(--foreground)]">Clip {index + 1}</span>
        <select
          value={config.continuity}
          onChange={(e) => patch({ continuity: e.target.value as Continuity })}
          className="ml-auto rounded-md border border-white/10 bg-[var(--card)] px-2 py-0.5 text-[10px] text-[var(--foreground)]"
        >
          <option value="none">New scene</option>
          {index > 0 && <option value="last_frame">Continue from last frame</option>}
        </select>
      </div>

      {/* Asset mode toggle */}
      <div className="mb-2 flex gap-1.5">
        {(["brand", "upload", "ai"] as AssetMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => patch({ assetMode: mode })}
            className={
              "rounded-md px-2 py-1 text-[10px] font-medium transition " +
              (config.assetMode === mode
                ? "bg-indigo-500/20 text-indigo-200"
                : "text-[var(--muted)] hover:bg-white/5")
            }
          >
            {mode === "brand" ? "Brand assets" : mode === "upload" ? "Uploads" : "AI creates"}
          </button>
        ))}
      </div>

      {/* Asset grid (brand + upload modes) */}
      {config.assetMode !== "ai" && (
        <div className="mb-2">
          {config.assetMode === "brand" && laneAssets.length > 0 && (
            <div className="grid grid-cols-6 gap-1">
              {laneAssets.map((a) => {
                const checked = selectedSet.has(a.id);
                return (
                  <button key={a.id} type="button" onClick={() => toggleAsset(a.id)}
                    title={a.label}
                    className={
                      "relative aspect-square overflow-hidden rounded border transition " +
                      (checked ? "border-indigo-400 ring-1 ring-indigo-400/40" : "border-white/10 hover:border-white/30")
                    }>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/brand/assets/${encodeURIComponent(a.id)}?w=200`} alt={a.label}
                      className="h-full w-full object-contain" loading="lazy" />
                    {checked && (
                      <span className="absolute right-0.5 top-0.5 grid h-3 w-3 place-items-center rounded-full bg-indigo-500 text-[7px] text-white">✓</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {config.assetMode === "brand" && laneAssets.length === 0 && (
            <p className="text-[10px] text-[var(--muted)]">No brand assets selected for this lane. Use the Brand (🎨) icon to select assets first.</p>
          )}
          {config.assetMode === "upload" && (
            <div className="flex flex-col gap-1.5">
              {uploads.length > 0 && (
                <div className="grid grid-cols-6 gap-1">
                  {uploads.map((u) => {
                    const checked = selectedSet.has(u.path);
                    return (
                      <button key={u.path} type="button" onClick={() => toggleAsset(u.path)}
                        title={u.filename}
                        className={
                          "relative aspect-square overflow-hidden rounded border transition " +
                          (checked ? "border-indigo-400 ring-1 ring-indigo-400/40" : "border-white/10 hover:border-white/30")
                        }>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={thumbUrl(instanceId, u.path, undefined, 200)} alt={u.filename}
                          className="h-full w-full object-contain" loading="lazy" />
                        {checked && (
                          <span className="absolute right-0.5 top-0.5 grid h-3 w-3 place-items-center rounded-full bg-indigo-500 text-[7px] text-white">✓</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp"
                onChange={handleUpload} className="hidden" />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
                className="rounded-lg border border-dashed border-white/15 px-2 py-1.5 text-[10px] text-[var(--muted)] transition hover:border-indigo-400/40 hover:text-indigo-300">
                {uploading ? "Uploading…" : "+ Upload reference image"}
              </button>
            </div>
          )}
        </div>
      )}

      {config.assetMode === "ai" && (
        <p className="mb-2 text-[10px] text-[var(--muted)]">
          The AI will create its own assets to fit the story line for this clip.
        </p>
      )}

      {/* Prompt hint */}
      <textarea
        value={config.promptHint}
        onChange={(e) => patch({ promptHint: e.target.value })}
        placeholder="Optional: describe what happens in this clip (overrides the base story for this clip)"
        rows={2}
        className="w-full rounded-md border border-white/10 bg-[var(--card)] px-2 py-1.5 text-[11px] text-[var(--foreground)] placeholder:text-[var(--muted)]/50"
      />
    </div>
  );
}

function ReviewStep(props: {
  clipCount: number;
  clipDuration: number;
  resolution: string;
  quality: Quality;
  aspectRatio: string;
  baseStory: string;
  clipConfigs: ClipConfig[];
  estMinutes: number;
  totalCost: string;
}) {
  const { clipCount, clipDuration, resolution, quality, aspectRatio, baseStory, clipConfigs, estMinutes, totalCost } = props;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
        <h3 className="mb-3 text-xs font-semibold text-[var(--foreground)]">Summary</h3>
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <SummaryRow label="Clips" value={`${clipCount}`} />
          <SummaryRow label="Duration each" value={`${clipDuration}s`} />
          <SummaryRow label="Total length" value={`${clipCount * clipDuration}s`} />
          <SummaryRow label="Resolution" value={resolution} />
          <SummaryRow label="Quality" value={quality} />
          <SummaryRow label="Aspect ratio" value={aspectRatio} />
          <SummaryRow label="Est. time" value={`~${estMinutes} min`} />
          <SummaryRow label="Cost per clip" value={totalCost} />
        </div>
        {baseStory && (
          <div className="mt-3 border-t border-white/5 pt-2">
            <p className="text-[10px] uppercase tracking-wider text-[var(--muted)]">Base story</p>
            <p className="mt-0.5 text-[11px] text-[var(--foreground)]">{baseStory}</p>
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold text-[var(--foreground)]">Clip breakdown</h3>
        <div className="flex flex-col gap-1.5">
          {clipConfigs.map((c, i) => (
            <div key={i} className="flex items-center gap-2 rounded-md border border-white/5 bg-white/[0.01] px-3 py-1.5 text-[10px]">
              <span className="font-medium text-indigo-300">Clip {i + 1}</span>
              <span className="text-[var(--muted)]">
                {c.continuity === "last_frame" ? "↻ continue" : "✦ new scene"}
              </span>
              <span className="text-[var(--muted)]">
                {c.assetMode === "ai" ? "AI-created assets" :
                  `${c.brandAssets.length + c.uploadedAssets.length} asset(s)`}
              </span>
              {c.promptHint && (
                <span className="truncate text-[var(--muted)]/70">&ldquo;{c.promptHint}&rdquo;</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-amber-400/20 bg-amber-500/[0.04] px-3 py-2 text-[11px] text-amber-200/80">
        ⚠ This process may take 10–30+ minutes depending on clip count and resolution.
        You can close this wizard — the automation runs in the background and clips appear in the studio as they complete.
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[var(--muted)]">{label}</span>
      <span className="font-medium text-[var(--foreground)]">{value}</span>
    </div>
  );
}

// ── Icons ───────────────────────────────────────────────────────────────────

function SparkleHeaderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-300" aria-hidden>
      <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
