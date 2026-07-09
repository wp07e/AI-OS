"use client";

import { useState } from "react";
import type { BrandKit } from "@/lib/brand/types";

interface Props {
  brand: BrandKit;
  update: (partial: Partial<BrandKit>) => void;
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * Role-keyed color palette editor. Each row is a role name + hex (native color
 * picker bound to a text input). Roles can be added/renamed/deleted. Usage
 * notes live alongside each role (optional). Both `colors` and `color_usage`
 * maps are written through `update` on every change.
 */
export function BrandColorsPanel({ brand, update }: Props) {
  const [newRole, setNewRole] = useState("");
  const roles = Object.keys(brand.colors);

  function setHex(role: string, hex: string) {
    update({ colors: { ...brand.colors, [role]: hex } });
  }
  function setUsage(role: string, note: string) {
    update({ color_usage: { ...brand.color_usage, [role]: note } });
  }
  function removeRole(role: string) {
    const colors = { ...brand.colors };
    const usage = { ...brand.color_usage };
    delete colors[role];
    delete usage[role];
    update({ colors, color_usage: usage });
  }
  function addRole() {
    const role = newRole.trim();
    if (!role || brand.colors[role]) return;
    update({ colors: { ...brand.colors, [role]: "#6366f1" } });
    setNewRole("");
  }

  return (
    <section className="rounded-xl border border-white/10 bg-[var(--card)]/30 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--foreground)]">Colors</h3>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">
            Role-based palette. Each hex is baked into the design prompt exactly as written.
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {roles.length === 0 && (
          <p className="rounded-lg border border-dashed border-white/10 px-3 py-3 text-center text-[11px] text-[var(--muted)]">
            No colors yet — add one below (e.g. <code>accent</code>, <code>background</code>).
          </p>
        )}

        {roles.map((role) => {
          const hex = brand.colors[role];
          const valid = HEX_RE.test(hex);
          return (
            <div key={role} className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-2 rounded-lg border border-white/5 bg-black/10 px-2 py-1.5">
              {/* swatch + native picker */}
              <div className="relative h-7 w-7 shrink-0 overflow-hidden rounded-md border border-white/10">
                <input
                  type="color"
                  value={valid ? hex : "#6366f1"}
                  onChange={(e) => setHex(role, e.target.value)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  aria-label={`${role} color`}
                />
                <span className="block h-full w-full" style={{ backgroundColor: valid ? hex : "#6366f1" }} />
              </div>
              {/* role name */}
              <input
                type="text"
                value={role}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next === role) return;
                  const colors = { ...brand.colors };
                  const usage = { ...brand.color_usage };
                  delete colors[role];
                  delete usage[role];
                  colors[next] = hex;
                  if (brand.color_usage[role]) usage[next] = brand.color_usage[role];
                  update({ colors, color_usage: usage });
                }}
                className="w-full rounded-md border border-white/10 bg-black/20 px-2 py-1 text-xs text-[var(--foreground)] outline-none focus:border-indigo-400/50"
              />
              {/* hex */}
              <input
                type="text"
                value={hex}
                onChange={(e) => setHex(role, e.target.value)}
                placeholder="#6366F1"
                className={
                  "w-full rounded-md border bg-black/20 px-2 py-1 font-mono text-xs uppercase outline-none focus:border-indigo-400/50 " +
                  (valid ? "border-white/10 text-[var(--foreground)]" : "border-amber-400/40 text-amber-300")
                }
              />
              <button
                onClick={() => removeRole(role)}
                title={`Remove ${role}`}
                className="grid h-7 w-7 place-items-center rounded-md text-[var(--muted)] transition hover:bg-red-500/15 hover:text-red-300"
              >
                <TrashGlyph />
              </button>
              {/* usage note (spans full width) */}
              <input
                type="text"
                value={brand.color_usage[role] ?? ""}
                onChange={(e) => setUsage(role, e.target.value)}
                placeholder="usage note (optional) — e.g. 'CTAs and highlights only'"
                className="col-span-full w-full rounded-md border border-white/5 bg-black/10 px-2 py-1 text-[11px] text-[var(--foreground)]/80 outline-none focus:border-indigo-400/40"
              />
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          type="text"
          value={newRole}
          onChange={(e) => setNewRole(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addRole();
            }
          }}
          placeholder="new role name…"
          className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted)]/60 focus:border-indigo-400/50"
        />
        <button
          onClick={addRole}
          disabled={!newRole.trim() || !!brand.colors[newRole.trim()]}
          className="shrink-0 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-semibold transition hover:bg-white/[0.07] disabled:opacity-40"
        >
          Add color
        </button>
      </div>
    </section>
  );
}

function TrashGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
