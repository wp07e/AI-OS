import { signAssetToken } from "./asset-token";

/**
 * Public base URL of the deployed host. When set, brand-asset URLs are built
 * against it so Canva's servers can fetch them via upload-asset-from-url
 * (Tier 2 real asset embedding). When unset (local dev), asset embedding is
 * disabled and the pipeline falls back to Tier 1 (describe assets in the prompt).
 *
 * Example: https://os.abdspros.com
 */
export const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? "";

/** True when real asset embedding (Tier 2) is available. */
export function assetEmbeddingEnabled(): boolean {
  return PUBLIC_BASE_URL.length > 0;
}

/**
 * Builds a publicly-fetchable URL for a brand asset, signed so Canva's servers
 * can retrieve it without a session cookie. Returns null when embedding is
 * disabled (no PUBLIC_BASE_URL) — callers then fall back to Tier 1.
 */
export function publicAssetUrl(username: string, assetId: string): string | null {
  if (!assetEmbeddingEnabled()) return null;
  const token = signAssetToken(username, assetId);
  return `${PUBLIC_BASE_URL}/brand-assets/${encodeURIComponent(assetId)}?t=${token}`;
}
