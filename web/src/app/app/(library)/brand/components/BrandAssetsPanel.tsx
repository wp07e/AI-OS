"use client";

import { useRef, useState } from "react";
import type { AssetCategory, BrandAsset, BrandKit } from "@/lib/brand/types";

interface Props {
  brand: BrandKit;
  uploadAsset: (file: File, category: AssetCategory, label?: string) => Promise<void>;
  deleteAsset: (id: string) => Promise<void>;
  /** When set, render only this single category (no outer section chrome). Used
   *  by per-asset-category card pages. */
  onlyCategory?: AssetCategory;
}

const CATEGORIES: { key: AssetCategory; label: string; hint: string }[] = [
  { key: "logo", label: "Logos", hint: "Primary brand marks (PNG with transparency works best)." },
  { key: "photo", label: "Photos / Backgrounds", hint: "Full-bleed imagery and texture backgrounds." },
  { key: "component", label: "Components", hint: "Pre-made PNG/JPG graphic elements." },
  { key: "icon", label: "Icons", hint: "Small symbol graphics for callouts." },
];

/**
 * Asset library, grouped by category. Each category is a drop zone + thumbnail
 * grid with delete. Uploads POST to /api/brand/assets; deletes DELETE
 * /api/brand/assets/<id>. Thumbnails load via GET /api/brand/assets/<id>.
 *
 * When `onlyCategory` is set, renders just that one category without the outer
 * section header — used by the per-category card pages (Logos, Photos, …).
 */
export function BrandAssetsPanel({ brand, uploadAsset, deleteAsset, onlyCategory }: Props) {
  const cats = onlyCategory
    ? CATEGORIES.filter((c) => c.key === onlyCategory)
    : CATEGORIES;

  if (onlyCategory) {
    const cat = cats[0];
    return (
      <AssetCategoryGrid
        category={cat.key}
        label={cat.label}
        hint={cat.hint}
        assets={brand.assets.filter((a) => a.category === cat.key)}
        uploadAsset={uploadAsset}
        deleteAsset={deleteAsset}
      />
    );
  }

  return (
    <section className="rounded-xl border border-white/10 bg-[var(--card)]/30 p-4">
      <h3 className="text-sm font-semibold text-[var(--foreground)]">Assets</h3>
      <p className="mt-0.5 text-[11px] text-[var(--muted)]">
        Upload logos, background photos, components, and icons. (PNG, JPG, GIF, WEBP, SVG.)
      </p>

      <div className="mt-3 flex flex-col gap-4">
        {cats.map((cat) => (
          <AssetCategoryGrid
            key={cat.key}
            category={cat.key}
            label={cat.label}
            hint={cat.hint}
            assets={brand.assets.filter((a) => a.category === cat.key)}
            uploadAsset={uploadAsset}
            deleteAsset={deleteAsset}
          />
        ))}
      </div>
    </section>
  );
}

function AssetCategoryGrid({
  category,
  label,
  hint,
  assets,
  uploadAsset,
  deleteAsset,
}: {
  category: AssetCategory;
  label: string;
  hint: string;
  assets: BrandAsset[];
  uploadAsset: (file: File, category: AssetCategory, label?: string) => Promise<void>;
  deleteAsset: (id: string) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        await uploadAsset(file, category);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--muted)]">
          {label}
        </span>
        <span className="text-[10px] text-[var(--muted)]/70">{assets.length}</span>
      </div>

      {/* drop zone */}
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={
          "mt-1 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-3 py-4 text-center transition " +
          (dragOver
            ? "border-indigo-400/60 bg-indigo-500/10"
            : "border-white/10 bg-black/10 hover:border-white/20 hover:bg-white/[0.03]")
        }
      >
        <UploadGlyph />
        <span className="text-[11px] text-[var(--muted)]">
          {busy ? "Uploading…" : "Drop files or click to upload"}
        </span>
        <span className="text-[10px] text-[var(--muted)]/60">{hint}</span>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
        />
      </div>
      {error && (
        <p className="mt-1 rounded-md bg-red-500/10 px-2 py-1 text-[10px] text-red-300">{error}</p>
      )}

      {/* thumbnails */}
      {assets.length > 0 && (
        <div className="mt-2 grid grid-cols-4 gap-2">
          {assets.map((asset) => (
            <AssetThumb key={asset.id} asset={asset} onDelete={() => deleteAsset(asset.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function AssetThumb({ asset, onDelete }: { asset: BrandAsset; onDelete: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  async function doDelete() {
    setPending(true);
    try {
      await onDelete();
    } catch {
      setPending(false);
      setConfirming(false);
    }
  }
  return (
    <div className="group relative aspect-square overflow-hidden rounded-lg border border-white/10 bg-black/30">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/brand/assets/${encodeURIComponent(asset.id)}`}
        alt={asset.label}
        className="h-full w-full object-contain"
        loading="lazy"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-3">
        <p className="truncate text-[9px] text-white/80">{asset.label}</p>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (pending) return;
          if (confirming) doDelete();
          else setConfirming(true);
        }}
        onBlur={() => setConfirming(false)}
        title={confirming ? "Click again to confirm" : "Delete asset"}
        className={
          "absolute right-1 top-1 grid h-6 w-6 place-items-center rounded text-white opacity-0 transition group-hover:opacity-100 " +
          (confirming ? "bg-red-500/80 opacity-100" : "bg-black/50 hover:bg-red-500/70")
        }
      >
        {pending ? (
          <span className="block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
        ) : confirming ? (
          <span className="text-[10px] font-bold">×</span>
        ) : (
          <TrashGlyph />
        )}
      </button>
    </div>
  );
}

function UploadGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--muted)]" aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
