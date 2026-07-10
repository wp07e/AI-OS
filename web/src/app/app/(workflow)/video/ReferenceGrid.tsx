"use client";

import { useMemo, useRef, useState } from "react";
import type { BrandKit } from "@/lib/brand/types";
import type { UploadedRef } from "./lib";
import { uploadReference, fileUrl } from "./lib";

/**
 * Multi-select grid of reference images from two sources:
 *   1. Global brand assets (from the brand kit)
 *   2. Per-instance uploads (one-off images not part of the brand)
 *
 * Selection is held as a flat list of identifiers by the parent. Brand assets
 * use their uuid; uploads use their relative path ("uploads/<uuid>.<ext>").
 * The generate route + script resolve both formats.
 *
 * Includes a dropzone for uploading new one-off references.
 */
interface Props {
  instanceId: string;
  kit: BrandKit | null;
  uploads: UploadedRef[];
  selected: string[];
  onToggle: (id: string) => void;
  onUploaded: () => void;
}

export function ReferenceGrid({ instanceId, kit, uploads, selected, onToggle, onUploaded }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const brandAssets = useMemo(() => kit?.assets ?? [], [kit?.assets]);
  const selectedSet = new Set(selected);

  const hasAny = brandAssets.length > 0 || uploads.length > 0;

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
    <div className="flex flex-col gap-2">
      {hasAny && (
        <div className="max-h-40 overflow-y-auto">
          {brandAssets.length > 0 && (
            <>
              {uploads.length > 0 && (
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-[var(--muted)]/60">
                  Brand assets
                </p>
              )}
              <div className="grid grid-cols-5 gap-1.5">
                {brandAssets.map((a) => {
                  const checked = selectedSet.has(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onToggle(a.id)}
                      title={`${a.label}${a.category ? ` (${a.category})` : ""}`}
                      className={
                        "relative aspect-square overflow-hidden rounded-md border transition " +
                        (checked ? "border-indigo-400 ring-2 ring-indigo-400/40" : "border-white/10 hover:border-white/30")
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
                        <span className="absolute right-0.5 top-0.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-indigo-500 text-[8px] text-white">
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {uploads.length > 0 && (
            <div className={brandAssets.length > 0 ? "mt-2" : ""}>
              {brandAssets.length > 0 && (
                <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-[var(--muted)]/60">
                  Uploaded for this video
                </p>
              )}
              <div className="grid grid-cols-5 gap-1.5">
                {uploads.map((u) => {
                  const checked = selectedSet.has(u.path);
                  return (
                    <button
                      key={u.path}
                      type="button"
                      onClick={() => onToggle(u.path)}
                      title={u.filename}
                      className={
                        "relative aspect-square overflow-hidden rounded-md border transition " +
                        (checked ? "border-indigo-400 ring-2 ring-indigo-400/40" : "border-white/10 hover:border-white/30")
                      }
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={fileUrl(instanceId, u.path)}
                        alt={u.filename}
                        className="h-full w-full object-contain"
                        loading="lazy"
                      />
                      {checked && (
                        <span className="absolute right-0.5 top-0.5 grid h-3.5 w-3.5 place-items-center rounded-full bg-indigo-500 text-[8px] text-white">
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Upload dropzone */}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        onChange={handleUpload}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className="rounded-lg border border-dashed border-white/15 px-2 py-1.5 text-[10px] text-[var(--muted)] transition hover:border-indigo-400/40 hover:text-indigo-300 disabled:opacity-50"
      >
        {uploading ? "Uploading…" : "+ Upload reference image"}
      </button>
    </div>
  );
}
