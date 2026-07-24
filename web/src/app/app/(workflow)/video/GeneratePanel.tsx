"use client";

import { useMemo, useState } from "react";
import type { BrandKit } from "@/lib/brand/types";
import type { Continuity, GeneratedImage, Quality, VideoClip, VideoSettings } from "./types";
import { ReferenceGrid } from "./ReferenceGrid";
import {
  type UploadedRef,
  ASPECT_RATIOS,
  estimateImageCost,
  estimateVideoCost,
  fileUrl,
  thumbUrl,
  imageResolutionOptions,
  useGenerateSubmit,
  videoResolutionOptions,
} from "./lib";

interface Props {
  instanceId: string;
  kit: BrandKit | null;
  version?: string;
  /** All clips (for the "continue from last frame" source picker). */
  clips: VideoClip[];
  /** Generated images (for the "use instance image" starting-frame option). */
  images: GeneratedImage[];
  /** One-off uploaded reference images for this instance. */
  uploads: UploadedRef[];
  /** Which clip is currently selected (for extend/continue source), or null. */
  selectedClipIndex: number | null;
  /** True while the background script is running (phase is generating/downloading). */
  busy: boolean;
  /** Called after a successful submit so the parent can react (e.g. switch tab). */
  onUploaded?: () => void;
  /** Called after a successful submit so the parent can react (e.g. switch tab). */
  onSubmitted?: () => void;
}

/**
 * Right-side form for generating a video clip or image. Owns its own form
 * state; on submit it POSTs to the generate route (fire-and-forget) and the
 * canvas polls state.json for the result.
 *
 * Modeled on the carousel StudioToolbar's chat-trigger pattern, but uses a
 * direct form POST (the deterministic script path) rather than templated chat
 * messages — the form fields (quality, continuity, settings) are not things a
 * user wants to phrase in natural language.
 */
export function GeneratePanel({
  instanceId,
  kit,
  version,
  clips,
  images,
  uploads,
  selectedClipIndex,
  busy,
  onUploaded,
  onSubmitted,
}: Props) {
  const [tab, setTab] = useState<"video" | "image">("video");

  return (
    <aside className="flex min-h-0 flex-col overflow-y-auto border-l border-white/10 bg-[var(--card)]/20">
      <div className="flex shrink-0 border-b border-white/10 px-3 py-2">
        <TabButton active={tab === "video"} onClick={() => setTab("video")} label="Video" />
        <TabButton active={tab === "image"} onClick={() => setTab("image")} label="Image" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {busy && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-indigo-400/30 bg-indigo-500/10 px-3 py-2 text-[11px] text-indigo-200">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-indigo-300 border-t-transparent" />
            Generating… the script is working in the background.
          </div>
        )}
        {tab === "video" ? (
          <VideoForm
            instanceId={instanceId}
            kit={kit}
            clips={clips}
            images={images}
            uploads={uploads}
            selectedClipIndex={selectedClipIndex}
            version={version}
            busy={busy}
            onUploaded={onUploaded}
            onSubmitted={onSubmitted}
          />
        ) : (
          <ImageForm instanceId={instanceId} kit={kit} images={images} uploads={uploads} version={version} busy={busy} onUploaded={onUploaded} onSubmitted={onSubmitted} />
        )}
      </div>
    </aside>
  );
}

// ── Video form ─────────────────────────────────────────────────────────────

function VideoForm({
  instanceId,
  kit,
  clips,
  images,
  uploads,
  selectedClipIndex,
  version,
  busy,
  onUploaded,
  onSubmitted,
}: {
  instanceId: string;
  kit: BrandKit | null;
  clips: VideoClip[];
  images: GeneratedImage[];
  uploads: UploadedRef[];
  selectedClipIndex: number | null;
  version?: string;
  busy: boolean;
  onUploaded?: () => void;
  onSubmitted?: () => void;
}) {
  const { submit, submitting, error, clearError } = useGenerateSubmit(instanceId);
  const [prompt, setPrompt] = useState("");
  const [quality, setQuality] = useState<Quality>("low");
  const [duration, setDuration] = useState(6);
  const [aspect, setAspect] = useState("16:9");
  const [resolution, setResolution] = useState("720p");
  const [continuity, setContinuity] = useState<Continuity>("none");
  const [startMode, setStartMode] = useState<"none" | "brand" | "seed" | "image">("none");
  const [references, setReferences] = useState<string[]>([]);
  const [startImageExport, setStartImageExport] = useState<string | null>(null);

  const resOptions = useMemo(() => videoResolutionOptions(quality), [quality]);

  const toggleRef = (id: string) =>
    setReferences((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const needsStartImage = quality === "high";
  // High-quality video is image→video only: if the user is on "none" (text),
  // derive "seed" so a starting frame is always produced. Derived during render
  // rather than via an effect (React's recommended pattern for dependent state).
  const effectiveStartMode = needsStartImage && startMode === "none" ? "seed" : startMode;
  // Clamp resolution to a valid option for the current quality (1080p only on high).
  const effectiveResolution = resOptions.some((r) => r.value === resolution)
    ? resolution
    : resOptions[resOptions.length - 1].value;
  const withSeed = effectiveStartMode === "seed";
  const selectedClip = clips.find((c) => c.index === selectedClipIndex) ?? null;
  // A starting frame is active when continuing from a prior clip's last frame
  // OR a non-"none" starting-frame mode is selected (Brand/Generate/Image).
  // When active it occupies @image1, so user references begin at @image2.
  const hasStartingFrame = continuity === "last_frame" || effectiveStartMode !== "none";

  const canSubmit =
    prompt.trim().length > 0 &&
    !submitting &&
    !busy &&
    (continuity !== "extend" || selectedClip != null) &&
    (continuity !== "last_frame" || selectedClip != null);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const settings: VideoSettings = { quality, duration, aspect_ratio: aspect, resolution: effectiveResolution };
    const seedPrompt = effectiveStartMode === "seed" ? deriveSeedPrompt(prompt) : undefined;

    if (continuity === "extend") {
      const ok = await submit({
        op: "extend_video",
        prompt,
        quality,
        settings,
        references,
        sourceClipIndex: selectedClipIndex ?? undefined,
        continuity: "extend",
      });
      if (ok) onSubmitted?.();
      return;
    }

    // Resolve starting frame for image-to-video modes.
    let resolvedStartImage: string | undefined;
    if (continuity === "last_frame") {
      resolvedStartImage = undefined; // script extracts last frame from sourceClipIndex
    } else if (effectiveStartMode === "image" && startImageExport) {
      resolvedStartImage = startImageExport;
    } else if (effectiveStartMode === "brand" && references.length > 0) {
      // First selected brand ref is the frame; the script resolves the id → path.
      resolvedStartImage = references[0];
    }

    const sourceType = resolvedStartImage != null || continuity === "last_frame" || withSeed ? "image" : "text";

    const ok = await submit({
      op: "generate_video",
      prompt,
      quality,
      settings,
      references,
      seedPrompt,
      startImageExport: resolvedStartImage,
      continuity,
      sourceClipIndex: continuity === "last_frame" ? selectedClipIndex ?? undefined : undefined,
    });
    if (ok) {
      setPrompt("");
      setReferences([]);
      onSubmitted?.();
    }
    void sourceType; // advisory; the script records sourceType in state
  };

  const cost = estimateVideoCost(quality, effectiveResolution, duration, withSeed);

  return (
    <div className="flex flex-col gap-3">
      <Field label="Prompt">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the shot. e.g. ‘Slow camera push-in on the water cooler, condensation glistening, soft studio light.’"
          rows={3}
          className="w-full resize-none rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 text-xs text-[var(--foreground)] placeholder:text-[var(--muted)]/60 focus:border-indigo-400/50 focus:outline-none"
        />
      </Field>

      <Field label="Quality">
        <div className="grid grid-cols-2 gap-1.5">
          <ChoiceButton
            active={quality === "low"}
            onClick={() => setQuality("low")}
            label="Low"
            hint="grok-imagine-video"
          />
          <ChoiceButton
            active={quality === "high"}
            onClick={() => setQuality("high")}
            label="High"
            hint="grok-imagine-video-1.5"
          />
        </div>
      </Field>

      <Field label="Continuity">
        <div className="grid grid-cols-3 gap-1.5">
          <ChoiceButton active={continuity === "none"} onClick={() => setContinuity("none")} label="New" />
          <ChoiceButton
            active={continuity === "last_frame"}
            onClick={() => setContinuity("last_frame")}
            label="Continue"
            hint="from last frame"
            disabled={selectedClip == null}
          />
          <ChoiceButton
            active={continuity === "extend"}
            onClick={() => setContinuity("extend")}
            label="Extend"
            hint="same shot"
            disabled={selectedClip == null}
          />
        </div>
        {continuity !== "none" && selectedClip == null && (
          <p className="mt-1 text-[10px] text-amber-300">Select a clip in the filmstrip first.</p>
        )}
        {continuity === "last_frame" && selectedClip && (
          <p className="mt-1 text-[10px] text-[var(--muted)]/70">
            New clip starts from the last frame of clip {selectedClip.index + 1}.
          </p>
        )}
      </Field>

      {continuity === "none" && (
        <Field label="Starting frame (first frame of the video)">
          <div className="grid grid-cols-2 gap-1.5">
            <ChoiceButton
              active={effectiveStartMode === "none"}
              onClick={() => setStartMode("none")}
              label="None"
              hint="text-to-video"
              disabled={needsStartImage}
            />
            <ChoiceButton
              active={effectiveStartMode === "brand"}
              onClick={() => setStartMode("brand")}
              label="Brand"
              hint="1st ref"
            />
            <ChoiceButton
              active={effectiveStartMode === "seed"}
              onClick={() => setStartMode("seed")}
              label="Generate"
              hint="AI seed frame"
            />
            <ChoiceButton
              active={effectiveStartMode === "image"}
              onClick={() => setStartMode("image")}
              label="Image"
              hint="from gallery"
              disabled={images.length === 0}
            />
          </div>
          {needsStartImage && (
            <p className="mt-1 text-[10px] text-sky-300">
              High quality uses an image→video model — a starting frame is required (auto: Generate).
            </p>
          )}
          {effectiveStartMode === "image" && images.length > 0 && (
            <select
              value={startImageExport ?? ""}
              onChange={(e) => setStartImageExport(e.target.value || null)}
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-[var(--foreground)] focus:border-indigo-400/50 focus:outline-none"
            >
              <option value="">Pick a generated image…</option>
              {images
                .filter((g) => g.localPath)
                .map((g) => (
                  <option key={g.id} value={g.localPath ?? ""}>
                    {g.id} — {g.prompt.slice(0, 40)}
                  </option>
                ))}
            </select>
          )}
        </Field>
      )}

      {continuity !== "extend" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Duration">
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={1}
                  max={15}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  className="h-1 flex-1 accent-indigo-400"
                />
                <span className="w-10 text-right text-xs text-[var(--foreground)]">{duration}s</span>
              </div>
            </Field>
            <Field label="Aspect">
              <select
                value={aspect}
                onChange={(e) => setAspect(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-[var(--foreground)] focus:border-indigo-400/50 focus:outline-none"
              >
                {ASPECT_RATIOS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Resolution">
            <div className="flex gap-1.5">
              {resOptions.map((r) => (
                <ChoiceButton
                  key={r.value}
                  active={effectiveResolution === r.value}
                  onClick={() => setResolution(r.value)}
                  label={r.label}
                />
              ))}
            </div>
          </Field>
        </>
      )}

      <Field label="References (style & subject guides)">
        <ReferenceGrid instanceId={instanceId} kit={kit} uploads={uploads} selected={references} onToggle={toggleRef} onUploaded={() => onUploaded?.()} />
        <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--muted)]/70">
          Reference images guide the model&apos;s understanding of subjects and visual style. Reference them
          in your prompt by selection order: <code className="rounded bg-white/10 px-1">@image1</code>,{" "}
          <code className="rounded bg-white/10 px-1">@image2</code>, etc.
        </p>
        {hasStartingFrame && (
          <p className="mt-1.5 rounded-md border border-red-400/40 bg-red-500/10 px-2 py-1.5 text-[10px] font-medium leading-relaxed text-red-300">
            ⚠️ A starting frame is active, so it occupies{" "}
            <code className="rounded bg-red-500/20 px-1">@image1</code>. Your selected references
            start at <code className="rounded bg-red-500/20 px-1">@image2</code> — reference them
            accordingly in your prompt.
          </p>
        )}
      </Field>

      {images.length > 0 && (
        <Field label="Recent images">
          <div className="grid grid-cols-4 gap-1.5">
            {images.map((g) => {
              const selectedImg = startImageExport === g.localPath && effectiveStartMode === "image";
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => {
                    setStartMode("image");
                    setStartImageExport(g.localPath ?? null);
                  }}
                  title={g.prompt.slice(0, 60)}
                  className={
                    "relative aspect-square overflow-hidden rounded-md border transition " +
                    (selectedImg
                      ? "border-indigo-400 ring-2 ring-indigo-400/40"
                      : "border-white/10 hover:border-white/30")
                  }
                >
                  {g.localPath ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumbUrl(instanceId, g.localPath, version, 300)}
                      alt={g.prompt}
                      className="h-full w-full object-contain"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
                    </div>
                  )}
                  {selectedImg && (
                    <span className="absolute right-0.5 top-0.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-indigo-500 text-[8px] text-white">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <p className="mt-1 text-[10px] text-[var(--muted)]/70">
            Click an image to use it as the starting frame. Generate more in the Image tab.
          </p>
        </Field>
      )}

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-[10px] text-[var(--muted)]/70">{cost}</span>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-500 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-indigo-500/20 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/70 border-t-transparent" />}
          {submitting ? "Starting…" : busy ? "Generating…" : continuity === "extend" ? "Extend clip" : "Generate clip"}
        </button>
      </div>
    </div>
  );
}

function deriveSeedPrompt(prompt: string): string | undefined {
  // The seed frame should match the scene described by the video prompt. We
  // pass the video prompt as the seed prompt; the script may enrich it.
  return prompt.trim() || undefined;
}

// ── Image form ─────────────────────────────────────────────────────────────

function ImageForm({
  instanceId,
  kit,
  images,
  uploads,
  version,
  busy,
  onUploaded,
  onSubmitted,
}: {
  instanceId: string;
  kit: BrandKit | null;
  images: GeneratedImage[];
  uploads: UploadedRef[];
  version?: string;
  busy: boolean;
  onUploaded?: () => void;
  onSubmitted?: () => void;
}) {
  const { submit, submitting, error, clearError } = useGenerateSubmit(instanceId);
  const [prompt, setPrompt] = useState("");
  const [quality, setQuality] = useState<Quality>("low");
  const [aspect, setAspect] = useState("1:1");
  const [resolution, setResolution] = useState("1k");
  const [n, setN] = useState(1);
  const [references, setReferences] = useState<string[]>([]);
  void version; // reserved; gallery uses fileUrl directly

  const toggleRef = (id: string) =>
    setReferences((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const canSubmit = prompt.trim().length > 0 && !submitting && !busy;
  const cost = estimateImageCost(quality, resolution, n);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const settings: VideoSettings = { quality, aspect_ratio: aspect, resolution, n };
    const ok = await submit({
      op: references.length > 0 ? "edit_image" : "generate_image",
      prompt,
      quality,
      settings,
      references,
    });
    if (ok) {
      setPrompt("");
      setReferences([]);
      onSubmitted?.();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Field label="Prompt">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the image. e.g. ‘Our water cooler on a marble counter, morning light, photorealistic.’"
          rows={3}
          className="w-full resize-none rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 text-xs text-[var(--foreground)] placeholder:text-[var(--muted)]/60 focus:border-indigo-400/50 focus:outline-none"
        />
      </Field>

      <Field label="Quality">
        <div className="grid grid-cols-2 gap-1.5">
          <ChoiceButton active={quality === "low"} onClick={() => setQuality("low")} label="Low" hint="$0.002/img" />
          <ChoiceButton active={quality === "high"} onClick={() => setQuality("high")} label="High" hint="$0.01–0.07" />
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Aspect">
          <select
            value={aspect}
            onChange={(e) => setAspect(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-[var(--foreground)] focus:border-indigo-400/50 focus:outline-none"
          >
            {ASPECT_RATIOS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Count">
          <select
            value={n}
            onChange={(e) => setN(Number(e.target.value))}
            className="w-full rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-[var(--foreground)] focus:border-indigo-400/50 focus:outline-none"
          >
            {[1, 2, 3, 4].map((c) => (
              <option key={c} value={c}>
                {c} image{c > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Resolution">
        <div className="flex gap-1.5">
          {imageResolutionOptions().map((r) => (
            <ChoiceButton
              key={r.value}
              active={resolution === r.value}
              onClick={() => setResolution(r.value)}
              label={r.label}
            />
          ))}
        </div>
      </Field>

      <Field label="References (style & subject guides)">
        <ReferenceGrid instanceId={instanceId} kit={kit} uploads={uploads} selected={references} onToggle={toggleRef} onUploaded={() => onUploaded?.()} />
        <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--muted)]/70">
          Reference images guide the model&apos;s understanding of subjects and visual style. Reference them
          in your prompt by selection order: <code className="rounded bg-white/10 px-1">@image1</code>,{" "}
          <code className="rounded bg-white/10 px-1">@image2</code>, etc.
        </p>
      </Field>

      {error && <ErrorBanner message={error} onDismiss={clearError} />}

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-[10px] text-[var(--muted)]/70">{cost}</span>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="flex items-center gap-1.5 rounded-lg bg-indigo-500 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-indigo-500/20 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/70 border-t-transparent" />}
          {submitting ? "Starting…" : busy ? "Generating…" : "Generate image"}
        </button>
      </div>
      {images.length > 0 && <ImageGallery instanceId={instanceId} images={images} version={version} />}
    </div>
  );
}

// ── Shared bits ────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
        {label}
      </label>
      {children}
    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition " +
        (active ? "bg-indigo-500/20 text-indigo-200" : "text-[var(--muted)] hover:text-[var(--foreground)]")
      }
    >
      {label}
    </button>
  );
}

function ChoiceButton({
  active,
  onClick,
  label,
  hint,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "rounded-lg border px-2 py-1.5 text-center transition disabled:cursor-not-allowed disabled:opacity-40 " +
        (active
          ? "border-indigo-400 bg-indigo-500/15 text-indigo-200"
          : "border-white/10 bg-white/[0.02] text-[var(--foreground)]/80 hover:border-white/25")
      }
    >
      <span className="block text-[11px] font-semibold leading-tight">{label}</span>
      {hint && <span className="mt-0.5 block text-[9px] text-[var(--muted)]/70 leading-tight">{hint}</span>}
    </button>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
      <span className="flex-1">{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-red-300/60 transition hover:text-red-200"
          aria-label="Dismiss error"
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ── Image gallery (inside the Image form) ──────────────────────────────────

function ImageGallery({
  instanceId,
  images,
  version,
}: {
  instanceId: string;
  images: GeneratedImage[];
  version?: string;
}) {
  return (
    <div className="border-t border-white/10 pt-2">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
        Generated images
      </p>
      <div className="grid grid-cols-3 gap-1.5">
        {images.map((g) => (
          <div key={g.id} className="relative aspect-square overflow-hidden rounded-md border border-white/10">
            {g.localPath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumbUrl(instanceId, g.localPath, version, 300)}
                alt={g.prompt}
                className="h-full w-full object-contain"
                loading="lazy"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
