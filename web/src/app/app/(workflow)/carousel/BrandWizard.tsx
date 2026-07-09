"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AssetCategory, BrandKit } from "@/lib/brand/types";
import {
  type BrandSelection,
  emptySelection,
  normalizeSelection,
  selectionIsActive,
} from "@/lib/brand/selection";

interface Props {
  instanceId: string;
  onClose: () => void;
  onSaved?: () => void;
}

type Step = "identity" | "colors" | "typography" | "assets" | "confirm";
const STEP_ORDER: Step[] = ["identity", "colors", "typography", "assets", "confirm"];
const STEP_LABELS: Record<Step, string> = {
  identity: "Identity",
  colors: "Colors",
  typography: "Typography",
  assets: "Assets",
  confirm: "Confirm",
};

const ASSET_CATEGORIES: { key: AssetCategory; label: string; hint: string }[] = [
  { key: "logo", label: "Logos", hint: "Brand marks placed on slides." },
  { key: "photo", label: "Photos", hint: "Backgrounds & hero imagery." },
  { key: "component", label: "Components", hint: "Graphic elements." },
  { key: "icon", label: "Icons", hint: "Symbol graphics." },
];

/**
 * Per-lane Brand Selection wizard. A full-screen modal overlay that walks the
 * user through choosing which Brand Kit elements apply to THIS carousel lane.
 *
 * Reads the global kit (GET /api/brand) + the lane's current selection
 * (GET /api/workflows/<id>/brand-selection). Saves via PUT. Once saved, the
 * carousel pipeline auto-applies the selected brand to new slides generated
 * from this lane.
 */
export function BrandWizard({ instanceId, onClose, onSaved }: Props) {
  const [kit, setKit] = useState<BrandKit | null>(null);
  const [selection, setSelection] = useState<BrandSelection>(emptySelection());
  const [step, setStep] = useState<Step>("identity");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load kit + current selection on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [kitRes, selRes] = await Promise.all([
          fetch("/api/brand", { cache: "no-store" }),
          fetch(`/api/workflows/${instanceId}/brand-selection`, { cache: "no-store" }),
        ]);
        if (!kitRes.ok || !selRes.ok) throw new Error("load failed");
        const kitData = (await kitRes.json()) as { brand: BrandKit };
        const selData = (await selRes.json()) as { selection: BrandSelection };
        if (cancelled) return;
        setKit(kitData.brand);
        setSelection(normalizeSelection(selData.selection));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [instanceId]);

  const patch = useCallback((p: Partial<BrandSelection>) => {
    setSelection((prev) => ({ ...prev, ...p }));
  }, []);

  const toggleAsset = useCallback((cat: AssetCategory, id: string) => {
    setSelection((prev) => {
      const current = new Set(prev.assets[cat] ?? []);
      if (current.has(id)) current.delete(id);
      else current.add(id);
      return { ...prev, assets: { ...prev.assets, [cat]: [...current] } };
    });
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/${instanceId}/brand-selection`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selection),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const stepIndex = STEP_ORDER.indexOf(step);
  const kitColors = useMemo(() => Object.keys(kit?.colors ?? {}), [kit]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[var(--card)] shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-[var(--foreground)]">Brand for this carousel</h2>
            {selectionIsActive(selection) && (
              <span className="inline-flex items-center gap-1 rounded-full border border-indigo-400/30 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-200">
                <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
                Applied
              </span>
            )}
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
              onClick={() => setStep(s)}
              className={
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition " +
                (s === step
                  ? "bg-indigo-500/15 text-indigo-200"
                  : i < stepIndex
                    ? "text-[var(--foreground)]/60 hover:text-[var(--foreground)]"
                    : "text-[var(--muted)]")
              }
            >
              <span className={"grid h-4 w-4 place-items-center rounded-full text-[9px] " + (s === step ? "bg-indigo-400/30" : "bg-white/5")}>
                {i + 1}
              </span>
              {STEP_LABELS[s]}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex flex-col items-center gap-3 py-16">
              <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/10 border-t-indigo-400" />
              <p className="text-xs text-[var(--muted)]">Loading brand kit…</p>
            </div>
          ) : error ? (
            <div className="py-16 text-center">
              <p className="text-sm font-medium text-red-300">Couldn&apos;t load</p>
              <p className="mt-1 text-xs text-[var(--muted)]">{error}</p>
            </div>
          ) : (
            <StepBody
              step={step}
              kit={kit}
              selection={selection}
              patch={patch}
              toggleAsset={toggleAsset}
              kitColors={kitColors}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/10 px-5 py-3">
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--foreground)]/80">
              <input
                type="checkbox"
                checked={selection.enabled}
                onChange={(e) => patch({ enabled: e.target.checked })}
                className="h-3.5 w-3.5 accent-indigo-400"
              />
              Apply brand to this carousel
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => (stepIndex > 0 ? setStep(STEP_ORDER[stepIndex - 1]) : onClose())}
              className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium transition hover:bg-white/[0.07]"
            >
              {stepIndex > 0 ? "Back" : "Cancel"}
            </button>
            {step === "confirm" ? (
              <button
                onClick={save}
                disabled={saving}
                className="rounded-lg bg-indigo-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            ) : (
              <button
                onClick={() => setStep(STEP_ORDER[stepIndex + 1])}
                className="rounded-lg bg-indigo-500 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-400"
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepBody({
  step,
  kit,
  selection,
  patch,
  toggleAsset,
  kitColors,
}: {
  step: Step;
  kit: BrandKit | null;
  selection: BrandSelection;
  patch: (p: Partial<BrandSelection>) => void;
  toggleAsset: (cat: AssetCategory, id: string) => void;
  kitColors: string[];
}) {
  if (step === "identity") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-[var(--muted)]">
          Include the brand name and voice/tone in the design prompt.
        </p>
        <ToggleRow
          label="Brand name"
          value={kit?.name || "(not set)"}
          checked={selection.identity}
          onToggle={(v) => patch({ identity: v })}
        />
        {kit?.voice && (
          <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">Voice</p>
            <p className="mt-0.5 text-xs text-[var(--foreground)]/80">{kit.voice}</p>
          </div>
        )}
      </div>
    );
  }

  if (step === "colors") {
    const selectedRoles = selection.colors === "all" ? kitColors : selection.colors;
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-[var(--muted)]">Which brand colors apply to this carousel?</p>
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--foreground)]/80">
            <input
              type="checkbox"
              checked={selection.colors === "all"}
              onChange={(e) => patch({ colors: e.target.checked ? "all" : [] })}
              className="h-3 w-3 accent-indigo-400"
            />
            All
          </label>
        </div>
        {kitColors.length === 0 ? (
          <EmptyHint message="No colors in your brand kit yet. Add some in the Brand library." />
        ) : (
          <div className="grid gap-1.5">
            {kitColors.map((role) => {
              const hex = kit?.colors[role] ?? "#000000";
              const checked = selectedRoles.includes(role);
              return (
                <button
                  key={role}
                  onClick={() => {
                    if (selection.colors === "all") {
                      patch({ colors: kitColors.filter((r) => r !== role) });
                    } else {
                      const next = new Set(selectedRoles);
                      if (next.has(role)) next.delete(role);
                      else next.add(role);
                      patch({ colors: [...next] });
                    }
                  }}
                  className={
                    "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition " +
                    (checked ? "border-indigo-400/40 bg-indigo-500/10" : "border-white/10 bg-black/10 hover:bg-white/[0.03]")
                  }
                >
                  <span className="h-6 w-6 shrink-0 rounded-md border border-white/10" style={{ backgroundColor: hex }} />
                  <span className="flex-1 text-xs text-[var(--foreground)]">{role}</span>
                  <span className="font-mono text-[10px] uppercase text-[var(--muted)]">{hex}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (step === "typography") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-[var(--muted)]">
          Include the brand&apos;s font pairing and role mapping in the design prompt.
        </p>
        <ToggleRow
          label="Apply typography"
          value={kit?.typography.pairing || "(no pairing set)"}
          checked={selection.typography}
          onToggle={(v) => patch({ typography: v })}
        />
        {kit && kit.fonts.length > 0 && (
          <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">Fonts in kit</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {kit.fonts.map((f) => (
                <span key={f} className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-[var(--foreground)]/80">
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (step === "assets") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-xs text-[var(--muted)]">
          Select assets to use. Selected assets are described to the AI and embedded when asset embedding is enabled.
        </p>
        {ASSET_CATEGORIES.map((cat) => {
          const assets = (kit?.assets ?? []).filter((a) => a.category === cat.key);
          const selected = selection.assets[cat.key] ?? [];
          return (
            <div key={cat.key}>
              <div className="mb-1.5 flex items-baseline justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                  {cat.label}
                </span>
                <span className="text-[10px] text-[var(--muted)]/70">{selected.length} selected</span>
              </div>
              {assets.length === 0 ? (
                <p className="rounded-lg border border-dashed border-white/10 px-3 py-2 text-[11px] text-[var(--muted)]">
                  None in your kit. {cat.hint}
                </p>
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  {assets.map((a) => {
                    const checked = selected.includes(a.id);
                    return (
                      <button
                        key={a.id}
                        onClick={() => toggleAsset(cat.key, a.id)}
                        className={
                          "relative aspect-square overflow-hidden rounded-lg border transition " +
                          (checked ? "border-indigo-400 ring-2 ring-indigo-400/40" : "border-white/10 hover:border-white/20")
                        }
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/brand/assets/${encodeURIComponent(a.id)}`}
                          alt={a.label}
                          className="h-full w-full object-contain"
                          loading="lazy"
                        />
                        {checked && (
                          <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-indigo-500 text-[9px] text-white">
                            ✓
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // confirm
  const selectedColorCount = selection.colors === "all" ? kitColors.length : selection.colors.length;
  const totalAssets = Object.values(selection.assets).reduce((n, ids) => n + (ids?.length ?? 0), 0);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-[var(--muted)]">Review what will apply to slides generated from this lane:</p>
      <div className="grid gap-2">
        <SummaryRow label="Brand identity" value={selection.identity ? "On" : "Off"} on={selection.identity} />
        <SummaryRow label="Colors" value={`${selectedColorCount}`} on={selectedColorCount > 0} />
        <SummaryRow label="Typography" value={selection.typography ? "On" : "Off"} on={selection.typography} />
        <SummaryRow label="Assets" value={`${totalAssets}`} on={totalAssets > 0} />
      </div>
      {!selection.enabled && (
        <p className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          “Apply brand” is off — nothing will be applied. Turn it on below to use this selection.
        </p>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  value,
  checked,
  onToggle,
}: {
  label: string;
  value: string;
  checked: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onToggle(!checked)}
      className={
        "flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition " +
        (checked ? "border-indigo-400/40 bg-indigo-500/10" : "border-white/10 bg-black/10 hover:bg-white/[0.03]")
      }
    >
      <div className="flex flex-col">
        <span className="text-xs font-medium text-[var(--foreground)]">{label}</span>
        <span className="text-[11px] text-[var(--muted)]">{value}</span>
      </div>
      <span
        className={
          "relative h-5 w-9 shrink-0 rounded-full transition " +
          (checked ? "bg-indigo-500" : "bg-white/10")
        }
      >
        <span
          className={
            "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all " +
            (checked ? "left-[18px]" : "left-0.5")
          }
        />
      </span>
    </button>
  );
}

function SummaryRow({ label, value, on }: { label: string; value: string; on: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/10 px-3 py-2">
      <span className="text-xs text-[var(--foreground)]/80">{label}</span>
      <span className={"text-xs font-medium " + (on ? "text-indigo-200" : "text-[var(--muted)]")}>{value}</span>
    </div>
  );
}

function EmptyHint({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-dashed border-white/10 px-3 py-3 text-center text-[11px] text-[var(--muted)]">
      {message}
    </p>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
