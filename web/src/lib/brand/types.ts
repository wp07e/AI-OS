/**
 * Brand kit types.
 *
 * Brand is a per-user shared library (not a workflow instance): assets,
 * colors, and typography the user wants to reuse across carousels. It lives
 * as brand.json + assets/ under /workspace/brand/ in the user's container,
 * persisted via the per-user workspace volume.
 *
 * The metadata shape is a forward-compatible superset of the carousel
 * pipeline's brand block (see container/fixtures/brief.schema.jsonc). Phase B
 * can project { name, voice, colors, color_usage, typography } straight into
 * a brief's brand field.
 */

/** Asset categories the library manages. */
export type AssetCategory = "logo" | "photo" | "component" | "icon";

/** A single uploaded binary asset (image). */
export interface BrandAsset {
  /** Stable id; also the on-disk filename stem (uuid). */
  id: string;
  category: AssetCategory;
  /** Original uploaded filename, kept for display. */
  filename: string;
  /** Container-absolute path, e.g. /workspace/brand/assets/<id>.png */
  path: string;
  /** Detected MIME type (image/png, image/jpeg, ...). */
  mime: string;
  /** Size in bytes. */
  size: number;
  /** ISO timestamp of upload. */
  uploaded_at: string;
  /** User-editable label (defaults to filename). */
  label: string;
}

/** Per-role typography spec (matches fixtures brand.typography.roles). */
export interface TypographyRole {
  /** Font family NAME as Canva knows it (Inter, Montserrat, ...). */
  family: string;
  weight?: "normal" | "medium" | "semibold" | "bold" | "black";
}

/** The persisted brand kit. */
export interface BrandKit {
  name: string;
  voice: string;
  /** role → hex, e.g. { accent: "#7C5CFF", background: "#0B0B0F" }. */
  colors: Record<string, string>;
  /** role → usage note, rendered into the generate-design prompt later. */
  color_usage: Record<string, string>;
  typography: {
    pairing: string;
    roles: Record<string, TypographyRole>;
    fallback: string;
  };
  /** The user's chosen font catalog (family names). Subset of the curated
   *  list plus any custom additions. This drives the typography dropdowns. */
  fonts: string[];
  assets: BrandAsset[];
  lastUpdated: string;
}

/** Returns a fresh empty brand kit (used when none exists yet). */
export function emptyBrandKit(): BrandKit {
  return {
    name: "",
    voice: "",
    colors: {},
    color_usage: {},
    typography: { pairing: "", roles: {}, fallback: "" },
    fonts: [],
    assets: [],
    lastUpdated: new Date(0).toISOString(),
  };
}

/**
 * Coerces an unknown JSON object (read from disk) into a well-formed BrandKit,
 * filling missing fields with defaults. Tolerant of older/partial shapes so a
 * half-written file never breaks the canvas.
 */
export function normalizeBrandKit(raw: unknown): BrandKit {
  const base = emptyBrandKit();
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  return {
    name: typeof obj.name === "string" ? obj.name : base.name,
    voice: typeof obj.voice === "string" ? obj.voice : base.voice,
    colors: isStringRecord(obj.colors) ? obj.colors : base.colors,
    color_usage: isStringRecord(obj.color_usage) ? obj.color_usage : base.color_usage,
    typography: normalizeTypography(obj.typography),
    fonts: Array.isArray(obj.fonts)
      ? obj.fonts.filter((f): f is string => typeof f === "string")
      : base.fonts,
    assets: Array.isArray(obj.assets)
      ? obj.assets.filter((a): a is BrandAsset => a != null && typeof a === "object" && "id" in a)
      : base.assets,
    lastUpdated: typeof obj.lastUpdated === "string" ? obj.lastUpdated : base.lastUpdated,
  };
}

function normalizeTypography(raw: unknown): BrandKit["typography"] {
  const base = emptyBrandKit().typography;
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  const rolesRaw = isRecord(obj.roles) ? obj.roles : {};
  const roles: Record<string, TypographyRole> = {};
  for (const [role, spec] of Object.entries(rolesRaw)) {
    if (spec && typeof spec === "object" && "family" in spec) {
      const s = spec as Record<string, unknown>;
      roles[role] = {
        family: typeof s.family === "string" ? s.family : "",
        weight: isValidWeight(s.weight) ? s.weight : undefined,
      };
    }
  }
  return {
    pairing: typeof obj.pairing === "string" ? obj.pairing : base.pairing,
    roles,
    fallback: typeof obj.fallback === "string" ? obj.fallback : base.fallback,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object";
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!isRecord(v)) return false;
  return Object.values(v).every((x) => typeof x === "string");
}

const WEIGHTS = ["normal", "medium", "semibold", "bold", "black"] as const;
type Weight = (typeof WEIGHTS)[number];
function isValidWeight(v: unknown): v is Weight {
  return typeof v === "string" && (WEIGHTS as readonly string[]).includes(v);
}
