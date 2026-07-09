"use client";

import type { BrandKit } from "@/lib/brand/types";

interface Props {
  brand: BrandKit;
  update: (partial: Partial<BrandKit>) => void;
}

/**
 * Brand name + voice/tone editor. Both are free-text fields that autosave via
 * the parent useBrandState debounced PUT.
 */
export function BrandIdentityPanel({ brand, update }: Props) {
  return (
    <section className="rounded-xl border border-white/10 bg-[var(--card)]/30 p-4">
      <h3 className="text-sm font-semibold text-[var(--foreground)]">Identity</h3>
      <p className="mt-0.5 text-[11px] text-[var(--muted)]">
        The brand name and voice guide how slides are written and styled.
      </p>

      <div className="mt-3 grid gap-3">
        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
            Brand name
          </span>
          <input
            type="text"
            value={brand.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="literal:e.g. Acme, Northwind, your_org"
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-[var(--foreground)] outline-none transition placeholder:text-[var(--muted)]/60 focus:border-indigo-400/50"
          />
        </label>

        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
            Voice / tone
          </span>
          <textarea
            value={brand.voice}
            onChange={(e) => update({ voice: e.target.value })}
            placeholder="e.g. Direct, technical, no hype. Confident but warm."
            rows={2}
            className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-[var(--foreground)] outline-none transition placeholder:text-[var(--muted)]/60 focus:border-indigo-400/50"
          />
        </label>
      </div>
    </section>
  );
}
