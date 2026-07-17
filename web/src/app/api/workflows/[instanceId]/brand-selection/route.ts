import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  getContainerForUser,
  readWorkspaceFileText,
  writeWorkspaceFileText,
} from "@/lib/docker";
import {
  type BrandSelection,
  emptySelection,
  normalizeSelection,
} from "@/lib/brand/selection";
import { publicAssetUrl } from "@/lib/config";
import { leaseManager } from "@/lib/gpu/lease-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SELECTION_FILENAME = "brand_selection.json";

/**
 * GET /api/workflows/<instanceId>/brand-selection
 *
 * Returns the lane's brand selection (which Brand Kit elements apply to this
 * carousel). Returns empty defaults when no selection exists yet.
 *
 * Auth: instance must belong to the current user. Container must be ready.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const { instanceId } = await ctx.params;
  const instance = db()
    .prepare("SELECT folder, workflow_type FROM workflow_instances WHERE id = ? AND user_id = ?")
    .get(instanceId, user.id) as { folder: string; workflow_type: string } | undefined;
  if (!instance) return new Response("not found", { status: 404 });

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return new Response("container not ready", { status: 503 });
  }

  const text = await readWorkspaceFileText(row, `${instance.folder}/${SELECTION_FILENAME}`);
  const selection: BrandSelection = text ? normalizeSelection(JSON.parse(text)) : emptySelection();
  return Response.json({ selection });
}

/**
 * PUT /api/workflows/<instanceId>/brand-selection
 *
 * Replaces the lane's brand selection. Body is the full BrandSelection object;
 * normalized before storage. Stamps selectedAt.
 */
export async function PUT(
  req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const { instanceId } = await ctx.params;
  const instance = db()
    .prepare("SELECT folder, workflow_type FROM workflow_instances WHERE id = ? AND user_id = ?")
    .get(instanceId, user.id) as { folder: string; workflow_type: string } | undefined;
  if (!instance) return new Response("not found", { status: 404 });

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return new Response("container not ready", { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const selection = normalizeSelection(body);
  selection.selectedAt = new Date().toISOString();

  // Resolve public URLs for each selected asset (Tier 2 embedding). The host
  // signs these (it holds the session secret); the container reads ready-made
  // URLs rather than needing the secret. null when embedding is disabled (dev).
  const resolvedAssetUrls: Record<string, string> = {};
  for (const ids of Object.values(selection.assets)) {
    for (const id of ids ?? []) {
      const url = publicAssetUrl(user.username, id);
      if (url) resolvedAssetUrls[id] = url;
    }
  }

  await writeWorkspaceFileText(
    row,
    `${instance.folder}/${SELECTION_FILENAME}`,
    JSON.stringify({ ...selection, resolvedAssetUrls }, null, 2) + "\n",
  );

  // For Blender lanes: immediately push selected brand assets to the GPU
  // instance so the agent can use them without waiting for re-provisioning.
  // Best-effort — if no lease is active, assets will be pushed on next
  // provisioning instead.
  if (instance.workflow_type === "blender") {
    void leaseManager().pushBrandAssets(instanceId).catch(() => {});
  }

  return Response.json({ selection });
}
