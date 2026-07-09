import { currentUser } from "@/lib/auth";
import { getContainerForUser, readWorkspaceFileText } from "@/lib/docker";
import { db } from "@/lib/db";
import { loadBrandKit } from "@/lib/brand/store";
import { assetEmbeddingEnabled, publicAssetUrl } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/brand/diag — diagnostic for the Tier 2 asset-embedding path.
 *
 * Reports, for the current user:
 *   - whether the HOST sees PUBLIC_BASE_URL (assetEmbeddingEnabled)
 *   - the user's brand kit assets (ids/labels/categories)
 *   - the signed public URL for each asset (what would be written to
 *     brand_selection.json's resolvedAssetUrls on wizard save)
 *   - any existing brand_selection.json files across the user's carousel lanes
 *     and whether their resolvedAssetUrls is populated
 *
 * Auth: logged-in user. Container must be ready. NOT for production exposure —
 * remove or gate behind admin once the path is confirmed working.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return Response.json({ error: "container not ready" }, { status: 503 });
  }

  const kit = await loadBrandKit(row);

  // Build sample signed URLs for each asset (as the wizard PUT would).
  const assetUrls = kit.assets.map((a) => ({
    id: a.id,
    label: a.label,
    category: a.category,
    mime: a.mime,
    publicUrl: publicAssetUrl(user.username, a.id),
  }));

  // Inspect each carousel lane's brand_selection.json.
  const lanes = db()
    .prepare("SELECT id, title, folder FROM workflow_instances WHERE user_id = ? AND workflow_type = 'carousel'")
    .all(user.id) as { id: string; title: string; folder: string }[];
  const laneSelections = await Promise.all(
    lanes.map(async (l) => {
      const text = await readWorkspaceFileText(row, `${l.folder}/brand_selection.json`);
      let parsed: Record<string, unknown> | null = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { parseError: true };
        }
      }
      const resolved = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).resolvedAssetUrls : null;
      return {
        id: l.id,
        title: l.title,
        hasSelection: !!text,
        enabled: parsed ? Boolean((parsed as Record<string, unknown>).enabled) : false,
        resolvedAssetUrlCount: resolved && typeof resolved === "object" ? Object.keys(resolved as object).length : 0,
      };
    }),
  );

  return Response.json({
    hostPublicBaseUrlSet: assetEmbeddingEnabled(),
    hostUsername: user.username,
    assetCount: kit.assets.length,
    assetUrls,
    laneSelections,
  });
}
