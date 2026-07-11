import sharp from "sharp";

/**
 * On-the-fly image thumbnailing for display previews.
 *
 * Images are served from the Docker container at full resolution. For small-tile
 * displays (filmstrip, asset grids, reference selectors) we resize on-the-fly
 * via the ?w= query param. Sharp (already installed as a Next.js dependency)
 * handles the resize — no container-side changes needed.
 */

/** Image extensions that sharp can process. */
const RESIZABLE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

/** Whether a file extension is an image sharp can resize. */
export function isResizable(ext: string): boolean {
  return RESIZABLE_EXTS.has(ext.toLowerCase());
}

/**
 * Resize an image buffer to a max width, preserving aspect ratio.
 * Returns JPEG quality 80 (good enough for thumbnails, ~10x smaller).
 * Returns null if the input isn't a valid image (caller falls back to raw).
 */
export async function resizeImage(buf: Buffer, width: number): Promise<Buffer | null> {
  try {
    return await sharp(buf)
      .resize({ width, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * Parse the ?w= query param from a request URL.
 * Clamped to 50–1200px. Returns undefined if absent or invalid.
 */
export function parseWidthParam(url: URL): number | undefined {
  const w = url.searchParams.get("w");
  if (!w) return undefined;
  const n = parseInt(w, 10);
  if (isNaN(n)) return undefined;
  return Math.min(1200, Math.max(50, n));
}
