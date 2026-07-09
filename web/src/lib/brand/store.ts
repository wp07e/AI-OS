/**
 * Server-side brand-kit storage helpers.
 *
 * The brand kit lives in the user's container at /workspace/brand/brand.json
 * (metadata) + /workspace/brand/assets/<id>.<ext> (uploaded binaries). These
 * helpers centralize path resolution + JSON read/normalize/write so the
 * /api/brand/* routes stay thin.
 *
 * All functions take a resolved ContainerRow (caller verifies ownership +
 * container-ready first).
 */

import type { ContainerRow } from "@/lib/db";
import {
  readWorkspaceFileText,
  writeWorkspaceFileText,
  ensureWorkspaceDir,
} from "@/lib/docker";
import {
  type BrandKit,
  emptyBrandKit,
  normalizeBrandKit,
} from "./types";

/** Container-absolute dir for the brand library. */
export const BRAND_DIR = "/workspace/brand";
/** Container-absolute dir for uploaded brand assets. */
export const BRAND_ASSETS_DIR = `${BRAND_DIR}/assets`;
/** Container-absolute path to the brand metadata file. */
export const BRAND_JSON_PATH = `${BRAND_DIR}/brand.json`;

/**
 * Loads the brand kit. Returns an empty kit (with epoch lastUpdated) when no
 * file exists yet — callers treat that as "brand not configured".
 */
export async function loadBrandKit(row: ContainerRow): Promise<BrandKit> {
  const text = await readWorkspaceFileText(row, BRAND_JSON_PATH);
  if (!text) return emptyBrandKit();
  try {
    return normalizeBrandKit(JSON.parse(text));
  } catch {
    // Corrupt JSON shouldn't break the canvas — return empty and let the next
    // PUT overwrite it with a clean file.
    return emptyBrandKit();
  }
}

/**
 * Persists the full brand kit (metadata only — assets[] is metadata here, the
 * binary lives separately). Stamps lastUpdated. Ensures the brand dir exists.
 */
export async function saveBrandKit(
  row: ContainerRow,
  kit: BrandKit,
): Promise<BrandKit> {
  await ensureWorkspaceDir(row, BRAND_DIR);
  const stamped = { ...kit, lastUpdated: new Date().toISOString() };
  await writeWorkspaceFileText(row, BRAND_JSON_PATH, JSON.stringify(stamped, null, 2) + "\n");
  return stamped;
}
