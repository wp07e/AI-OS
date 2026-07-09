"use client";

import { useState } from "react";
import type { BrandKit, TypographyRole } from "@/lib/brand/types";
import {
  FONT_CATEGORIES,
  FONT_CATEGORY_LABELS,
  FONTS_BY_CATEGORY,
  isKnownCanvaFont,
} from "@/lib/fonts/canva-fonts";

interface Props {
  brand: BrandKit;
  update: (partial: Partial<BrandKit>) => void;
}

const TYPO_ROLES = ["headline", "body", "cta", "caption", "stat", "label"] as const;
const WEIGHTS = ["normal", "medium", "semibold", "bold", "black"] as const;
// Non-empty weight values from a <select>, narrowed from string via WEIGHTS.
type TypographyWeight = NonNullable<TypographyRole["weight"]>;

/**
 * Typography editor in two parts:
 *
 * 1. Font catalog — the user's chosen font families (brand.fonts). Add from the
 *    curated Canva catalog, or type a custom name (with a warning that Canva
 *    may substitute a fallback). Remove with a chip ×.
 * 2. Role mapping — assign a family (from brand.fonts) + weight to each
 *    typography role, plus pairing + fallback description text.
 *
 * Fonts are description-only: the Canva MCP has no font-upload tool, so the
 * selected families are baked into the generate-design prompt later (Phase B).
 */
export function BrandTypographyPanel({ brand, update }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customFont, setCustomFont] = useState("");

  function addFont(name: string) {
    const clean = name.trim();
    if (!clean || brand.fonts.includes(clean)) return;
    update({ fonts: [...brand.fonts, clean] });
  }
  function removeFont(name: string) {
    update({ fonts: brand.fonts.filter((f) => f !== name) });
  }
  function setRole(role: string, patch: Partial<{ family: string; weight: TypographyWeight }>) {
    const prev = brand.typography.roles[role] ?? { family: "" };
    update({
      typography: {
        ...brand.typography,
        roles: { ...brand.typography.roles, [role]: { ...prev, ...patch } },
      },
    });
  }

  return (
    <section className="rounded-xl border border-white/10 bg-[var(--card)]/30 p-4">
      <h3 className="text-sm font-semibold text-[var(--foreground)]">Typography</h3>
      <p className="mt-0.5 text-[11px] text-[var(--muted)]">
        Font names are baked into the design prompt. Canva may substitute a fallback for families
        it doesn&apos;t recognize.
      </p>

      {/* ── Font catalog ──────────────────────────────────────────────── */}
      <div className="mt-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
            Font catalog ({brand.fonts.length})
          </span>
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] font-medium transition hover:bg-white/[0.07]"
          >
            {pickerOpen ? "Close" : "Add fonts"}
          </button>
        </div>

        {brand.fonts.length === 0 && !pickerOpen && (
          <p className="mt-2 rounded-lg border border-dashed border-white/10 px-3 py-3 text-center text-[11px] text-[var(--muted)]">
            No fonts selected yet. Click <span className="text-[var(--foreground)]">Add fonts</span> to pick from Canva&apos;s catalog.
          </p>
        )}

        <div className="mt-2 flex flex-wrap gap-1.5">
          {brand.fonts.map((name) => {
            const known = isKnownCanvaFont(name);
            return (
              <span
                key={name}
                title={known ? name : `${name} — not in Canva's default catalog; may be substituted`}
                className={
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs " +
                  (known
                    ? "border-indigo-400/30 bg-indigo-500/10 text-indigo-200"
                    : "border-amber-400/30 bg-amber-500/10 text-amber-200")
                }
              >
                {!known && <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />}
                <span className="font-medium">{name}</span>
                <button
                  onClick={() => removeFont(name)}
                  className="text-current/70 transition hover:text-current"
                  aria-label={`Remove ${name}`}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>

        {pickerOpen && (
          <div className="mt-2 rounded-lg border border-white/10 bg-black/20 p-3">
            {/* Custom add */}
            <div className="flex gap-2">
              <input
                type="text"
                value={customFont}
                onChange={(e) => setCustomFont(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (customFont.trim()) {
                      addFont(customFont);
                      setCustomFont("");
                    }
                  }
                }}
                placeholder="custom font name (e.g. uploaded to your Canva Brand Kit)…"
                className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted)]/60 focus:border-indigo-400/50"
              />
              <button
                onClick={() => {
                  if (customFont.trim()) {
                    addFont(customFont);
                    setCustomFont("");
                  }
                }}
                className="shrink-0 rounded-md border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-semibold transition hover:bg-white/[0.07]"
              >
                Add
              </button>
            </div>
            {!isKnownCanvaFont(customFont) && customFont.trim() && (
              <p className="mt-1.5 text-[10px] text-amber-300/80">
                Not in Canva&apos;s default catalog — Canva may substitute a fallback if it isn&apos;t in your Brand Kit.
              </p>
            )}

            {/* Curated catalog grouped by category */}
            <div className="mt-3 max-h-56 overflow-y-auto pr-1">
              {FONT_CATEGORIES.map((cat) => {
                const list = FONTS_BY_CATEGORY[cat] ?? [];
                const available = list.filter((f) => !brand.fonts.includes(f));
                if (available.length === 0) return null;
                return (
                  <div key={cat} className="mb-2">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                      {FONT_CATEGORY_LABELS[cat]}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {available.map((name) => (
                        <button
                          key={name}
                          onClick={() => addFont(name)}
                          className="rounded-md border border-white/5 bg-white/[0.02] px-2 py-1 text-[11px] text-[var(--foreground)]/80 transition hover:border-indigo-400/40 hover:bg-indigo-500/10 hover:text-indigo-200"
                        >
                          + {name}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Role mapping ──────────────────────────────────────────────── */}
      <div className="mt-4 grid gap-3">
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
            Pairing intent
          </span>
          <input
            type="text"
            value={brand.typography.pairing}
            onChange={(e) =>
              update({ typography: { ...brand.typography, pairing: e.target.value } })
            }
            placeholder="e.g. Geometric sans headlines + clean grotesque body."
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted)]/60 focus:border-indigo-400/50"
          />
        </label>

        <div className="grid gap-2">
          {TYPO_ROLES.map((role) => {
            const spec = brand.typography.roles[role];
            return (
              <div key={role} className="grid grid-cols-[80px_1fr_110px] items-center gap-2">
                <span className="text-[11px] font-medium capitalize text-[var(--foreground)]/80">
                  {role}
                </span>
                <select
                  value={spec?.family ?? ""}
                  onChange={(e) => setRole(role, { family: e.target.value })}
                  className="w-full rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-[var(--foreground)] outline-none focus:border-indigo-400/50"
                >
                  <option value="">— inherit / let AI pick —</option>
                  {brand.fonts.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <select
                  value={spec?.weight ?? ""}
                  onChange={(e) => {
                    const w = e.target.value;
                    // The <option>s are exactly WEIGHTS (+ ""); a non-empty value
                    // is therefore a valid TypographyWeight. Empty → no change.
                    if (WEIGHTS.includes(w as TypographyWeight)) {
                      setRole(role, { weight: w as TypographyWeight });
                    }
                  }}
                  className="w-full rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-[var(--foreground)] outline-none focus:border-indigo-400/50"
                >
                  <option value="">default</option>
                  {WEIGHTS.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>

        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
            Fallback family
          </span>
          <input
            type="text"
            value={brand.typography.fallback}
            onChange={(e) =>
              update({ typography: { ...brand.typography, fallback: e.target.value } })
            }
            placeholder="e.g. Inter (or Sans Serif if unavailable)"
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted)]/60 focus:border-indigo-400/50"
          />
        </label>
      </div>
    </section>
  );
}
