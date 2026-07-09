/**
 * The set of Brand Kit "cards" — the UI slices of the single brand.json file.
 * Shared by the card navigation (client) and the per-card preamble (server).
 *
 * Brand is ONE folder (/workspace/brand) with ONE file (brand.json); cards are
 * not separate folders, just views over sections of that file.
 */
export type BrandCardKey =
  | "identity"
  | "colors"
  | "typography"
  | "logo"
  | "photo"
  | "component"
  | "icon";

/** Human label for a card key. */
export const BRAND_CARD_LABELS: Record<BrandCardKey, string> = {
  identity: "Identity",
  colors: "Colors",
  typography: "Typography",
  logo: "Logos",
  photo: "Photos",
  component: "Components",
  icon: "Icons",
};

/** True if `v` is a valid BrandCardKey. */
export function isBrandCardKey(v: unknown): v is BrandCardKey {
  return (
    typeof v === "string" &&
    v in BRAND_CARD_LABELS
  );
}
