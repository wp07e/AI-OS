import { currentUser } from "@/lib/auth";
import {
  getContainerForUser,
  readWorkspaceFileBuffer,
  removeWorkspaceFile,
} from "@/lib/docker";
import { loadBrandKit, saveBrandKit } from "@/lib/brand/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/brand/assets/<assetId> — streams one brand asset's bytes (for
 * <img> thumbnails in the canvas). The asset id (a uuid) is matched against
 * brand.json's assets[] to resolve the on-disk path + MIME.
 *
 * Auth: user must own the kit; container must be ready.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ assetId: string }> },
) {
  const user = await currentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return new Response("container not ready", { status: 503 });
  }

  const { assetId } = await ctx.params;
  const kit = await loadBrandKit(row);
  const asset = kit.assets.find((a) => a.id === assetId);
  if (!asset) return new Response("not found", { status: 404 });

  const buf = await readWorkspaceFileBuffer(row, asset.path);
  if (!buf) return new Response("not found", { status: 404 });

  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": asset.mime,
      "Content-Length": String(buf.length),
      // Assets are mutable (delete/re-upload). no-cache → always revalidate.
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * DELETE /api/brand/assets/<assetId> — removes the binary + its metadata row.
 * The asset id must belong to the current user's kit.
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ assetId: string }> },
) {
  const user = await currentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return new Response("container not ready", { status: 503 });
  }

  const { assetId } = await ctx.params;
  const kit = await loadBrandKit(row);
  const asset = kit.assets.find((a) => a.id === assetId);
  if (!asset) return new Response("not found", { status: 404 });

  // Remove the binary first; if that fails we leave metadata intact so the UI
  // still matches disk. A missing file (already gone) is treated as success.
  try {
    await removeWorkspaceFile(row, asset.path);
  } catch {
    // Non-fatal: the metadata removal below still succeeds and the dangling
    // file is harmless (it'll be orphaned, not served).
  }

  kit.assets = kit.assets.filter((a) => a.id !== assetId);
  const saved = await saveBrandKit(row, kit);
  return Response.json({ brand: saved });
}
