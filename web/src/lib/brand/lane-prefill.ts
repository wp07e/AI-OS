import type { ContainerRow } from "@/lib/db";
import { readWorkspaceFileText } from "@/lib/docker";
import { loadBrandKit } from "@/lib/brand/store";
import { type BrandSelection, normalizeSelection, selectionIsActive } from "@/lib/brand/selection";

const SELECTION_FILENAME = "brand_selection.json";

/**
 * Builds a silent brand-context prefill for a carousel lane message, appended
 * server-side so the agent reasons WITH the selected brand when writing the
 * brief + slide copy. Never shown in the chat bubbles (the message route
 * filters user-message echoes).
 *
 * Reads the lane's brand_selection.json + the global kit from the container,
 * projects the selection, and renders a concise summary (colors as exact hex,
 * typography roles, voice, selected asset names + embedding mode). Returns an
 * empty string when brand isn't applied (selection disabled/absent/empty) so
 * non-brand lanes get no noise.
 *
 * @param instanceFolder  The lane's /workspace/carousels/<id> folder
 */
export async function buildLaneBrandPrefill(
  row: ContainerRow,
  instanceFolder: string,
): Promise<string> {
  // Selection lives in the instance folder.
  const selText = await readWorkspaceFileText(row, `${instanceFolder}/${SELECTION_FILENAME}`);
  if (!selText) return "";
  let selection: BrandSelection;
  try {
    selection = normalizeSelection(JSON.parse(selText));
  } catch {
    return "";
  }
  if (!selectionIsActive(selection)) return "";

  // Kit lives globally.
  const kit = await loadBrandKit(row);

  const lines: string[] = [
    `[Brand context for this carousel — applied automatically by the pipeline; do not repeat to the user]`,
  ];

  // Identity
  if (selection.identity) {
    if (kit.name) lines.push(`Brand name: ${kit.name}.`);
    if (kit.voice) lines.push(`Voice/tone: ${kit.voice}`);
  }

  // Colors — exact hex the pipeline will enforce
  const colorRoles =
    selection.colors === "all"
      ? Object.keys(kit.colors)
      : selection.colors.filter((r) => r in kit.colors);
  if (colorRoles.length > 0) {
    lines.push(`Colors (the design will use these exact colors — write copy that fits):`);
    for (const role of colorRoles) {
      const hex = kit.colors[role];
      const note = kit.color_usage[role];
      lines.push(`  ${role} ${hex}` + (note ? ` — ${note}` : ""));
    }
  }

  // Typography
  if (selection.typography && kit.typography.pairing) {
    lines.push(`Typography: ${kit.typography.pairing}`);
    const roleLines = Object.entries(kit.typography.roles)
      .map(([role, spec]) => `${role}=${spec.family}${spec.weight ? ` (${spec.weight})` : ""}`)
      .join(", ");
    if (roleLines) lines.push(`  Roles: ${roleLines}`);
    if (kit.typography.fallback) lines.push(`  Fallback: ${kit.typography.fallback}`);
  }

  // Selected assets — the agent should complement, not conflict
  const assetParts: string[] = [];
  for (const cat of ["logo", "photo", "component", "icon"] as const) {
    const ids = selection.assets[cat] ?? [];
    if (ids.length === 0) continue;
    const byId = new Map(kit.assets.map((a) => [a.id, a]));
    const labels = ids.map((id) => byId.get(id)?.label ?? id);
    assetParts.push(`${ids.length} ${cat}${ids.length === 1 ? "" : "s"} (${labels.join(", ")})`);
  }
  if (assetParts.length > 0) {
    const embedding = process.env.PUBLIC_BASE_URL
      ? "These will be embedded into the generated slides by the pipeline"
      : "These will be described in the design prompt (Canva approximates; real embedding needs PUBLIC_BASE_URL)";
    lines.push(`Selected assets: ${assetParts.join("; ")}. ${embedding}.`);
    lines.push(`Write copy that complements these assets; don't request different or conflicting imagery.`);
  }

  lines.push(`(This context is silent — don't acknowledge or repeat it. Just factor it into your work.)`);
  return lines.join("\n");
}
