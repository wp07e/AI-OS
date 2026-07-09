import { currentUser } from "@/lib/auth";
import { getContainerForUser } from "@/lib/docker";
import { loadBrandKit, saveBrandKit } from "@/lib/brand/store";
import type { BrandKit, TypographyRole } from "@/lib/brand/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/brand — returns the user's brand kit (or empty defaults).
 *
 * Auth: user must be logged in. Container must be ready (brand.json lives in
 * the per-user container workspace).
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return new Response("container not ready", { status: 503 });
  }

  const kit = await loadBrandKit(row);
  return Response.json({ brand: kit });
}

/**
 * PUT /api/brand — replaces the brand kit metadata (name, voice, colors,
 * color_usage, typography, fonts). assets[] is preserved from the existing
 * kit on disk (asset uploads have their own endpoints) and is NOT taken from
 * the request body, so a stale client can't clobber the asset list.
 *
 * The metadata-only fields are merged over the existing kit; assets are kept
 * as-is. This lets the debounced autosave in useBrandState fire safely.
 */
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return new Response("container not ready", { status: 503 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Carry forward assets from disk; everything else from the request.
  const existing = await loadBrandKit(row);
  const next: BrandKit = {
    name: str(body.name, existing.name),
    voice: str(body.voice, existing.voice),
    colors: strMap(body.colors, existing.colors),
    color_usage: strMap(body.color_usage, existing.color_usage),
    typography: {
      pairing: nestedStr(body.typography, "pairing", existing.typography.pairing),
      fallback: nestedStr(body.typography, "fallback", existing.typography.fallback),
      roles: mergeTypographyRoles(body.typography, existing.typography.roles),
    },
    fonts: strArray(body.fonts, existing.fonts),
    assets: existing.assets, // never overwritten by metadata PUT
    lastUpdated: existing.lastUpdated, // saveBrandKit stamps a fresh one
  };

  const saved = await saveBrandKit(row, next);
  return Response.json({ brand: saved });
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}
function strMap(v: unknown, fallback: Record<string, string>): Record<string, string> {
  if (v && typeof v === "object") {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
    }
    return out;
  }
  return fallback;
}
function strArray(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fallback;
}
function nestedStr(
  typography: unknown,
  key: "pairing" | "fallback",
  fallback: string,
): string {
  if (typography && typeof typography === "object") {
    const val = (typography as Record<string, unknown>)[key];
    if (typeof val === "string") return val;
  }
  return fallback;
}
function mergeTypographyRoles(
  typography: unknown,
  existing: Record<string, TypographyRole>,
): Record<string, TypographyRole> {
  if (!typography || typeof typography !== "object") return existing;
  const rolesRaw = (typography as Record<string, unknown>).roles;
  if (!rolesRaw || typeof rolesRaw !== "object") return existing;
  const out: Record<string, TypographyRole> = {};
  for (const [role, spec] of Object.entries(rolesRaw as Record<string, unknown>)) {
    if (spec && typeof spec === "object" && "family" in spec) {
      const s = spec as Record<string, unknown>;
      out[role] = {
        family: typeof s.family === "string" ? s.family : existing[role]?.family ?? "",
        weight: isValidWeightValue(s.weight) ? s.weight : existing[role]?.weight,
      };
    }
  }
  return out;
}

const WEIGHT_VALUES = ["normal", "medium", "semibold", "bold", "black"] as const;
type WeightValue = (typeof WEIGHT_VALUES)[number];
function isValidWeightValue(v: unknown): v is WeightValue {
  return typeof v === "string" && (WEIGHT_VALUES as readonly string[]).includes(v);
}
