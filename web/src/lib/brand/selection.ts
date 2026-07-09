import type { AssetCategory, BrandAsset, BrandKit } from "./types";

/**
 * Per-lane brand selection — which elements of the global Brand Kit apply to a
 * given carousel lane. Persisted as brand_selection.json in the instance folder.
 *
 * References the kit by asset id (stays in sync if the kit is edited). A missing
 * or `enabled: false` file means no brand is applied (the AI does its own thing).
 */
export interface BrandSelection {
  /** Master switch. false or missing file = brand ignored entirely. */
  enabled: boolean;
  /** Include the kit's name + voice in the design prompt. */
  identity: boolean;
  /** Which color roles to include. "all" or a list of role names. */
  colors: "all" | string[];
  /** Include the kit's typography (pairing + roles + fallback). */
  typography: boolean;
  /** Which assets to include, per category, by asset id. */
  assets: Partial<Record<AssetCategory, string[]>>;
  /** ISO timestamp of the last selection. */
  selectedAt: string;
}

/** A fresh default selection (nothing applied). */
export function emptySelection(): BrandSelection {
  return {
    enabled: false,
    identity: false,
    colors: "all",
    typography: false,
    assets: {},
    selectedAt: new Date(0).toISOString(),
  };
}

/** Coerces an unknown JSON object into a well-formed BrandSelection. */
export function normalizeSelection(raw: unknown): BrandSelection {
  const base = emptySelection();
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  const colors = obj.colors;
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : base.enabled,
    identity: typeof obj.identity === "boolean" ? obj.identity : base.identity,
    colors:
      colors === "all"
        ? "all"
        : Array.isArray(colors)
          ? colors.filter((c): c is string => typeof c === "string")
          : base.colors,
    typography: typeof obj.typography === "boolean" ? obj.typography : base.typography,
    assets: normalizeAssetSelection(obj.assets),
    selectedAt: typeof obj.selectedAt === "string" ? obj.selectedAt : base.selectedAt,
  };
}

function normalizeAssetSelection(
  raw: unknown,
): Partial<Record<AssetCategory, string[]>> {
  if (!raw || typeof raw !== "object") return {};
  const out: Partial<Record<AssetCategory, string[]>> = {};
  const valid: AssetCategory[] = ["logo", "photo", "component", "icon"];
  for (const cat of valid) {
    const list = (raw as Record<string, unknown>)[cat];
    if (Array.isArray(list)) {
      const ids = list.filter((id): id is string => typeof id === "string");
      if (ids.length > 0) out[cat] = ids;
    }
  }
  return out;
}

/** True if the selection has any brand element applied (beyond the empty default). */
export function selectionIsActive(sel: BrandSelection): boolean {
  if (!sel.enabled) return false;
  if (sel.identity || sel.typography) return true;
  if (sel.colors === "all" || (Array.isArray(sel.colors) && sel.colors.length > 0)) return true;
  return Object.values(sel.assets).some((ids) => ids && ids.length > 0);
}

/**
 * Projects a selection onto a BrandKit, returning the *effective* brand block
 * the carousel pipeline should consume. Only selected elements are included;
 * unselected kit elements are dropped. This is the shape that feeds
 * brief.brand → brand_preamble().
 */
export function projectSelection(
  kit: BrandKit,
  sel: BrandSelection,
): {
  name?: string;
  voice?: string;
  colors: Record<string, string>;
  color_usage: Record<string, string>;
  typography: BrandKit["typography"];
  /** Selected assets, resolved to their full metadata (path, mime, label). */
  assets: Partial<Record<AssetCategory, BrandAsset[]>>;
} {
  if (!sel.enabled) {
    return { colors: {}, color_usage: {}, typography: kit.typography, assets: {} };
  }
  // Colors
  const colorRoles =
    sel.colors === "all" ? Object.keys(kit.colors) : sel.colors.filter((r) => r in kit.colors);
  const colors: Record<string, string> = {};
  const color_usage: Record<string, string> = {};
  for (const role of colorRoles) {
    colors[role] = kit.colors[role];
    if (kit.color_usage[role]) color_usage[role] = kit.color_usage[role];
  }
  // Assets — resolve selected ids to their metadata
  const assets: Partial<Record<AssetCategory, BrandAsset[]>> = {};
  const byId = new Map(kit.assets.map((a) => [a.id, a]));
  for (const cat of ["logo", "photo", "component", "icon"] as AssetCategory[]) {
    const ids = sel.assets[cat];
    if (ids && ids.length > 0) {
      assets[cat] = ids.map((id) => byId.get(id)).filter((a): a is BrandAsset => !!a);
    }
  }
  return {
    ...(sel.identity && kit.name ? { name: kit.name } : {}),
    ...(sel.identity && kit.voice ? { voice: kit.voice } : {}),
    colors,
    color_usage,
    typography: sel.typography ? kit.typography : { pairing: "", roles: {}, fallback: "" },
    assets,
  };
}
