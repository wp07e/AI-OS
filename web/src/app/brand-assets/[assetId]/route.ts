import { db, type UserRow } from "@/lib/db";
import { getContainerForUser, readWorkspaceFileBuffer } from "@/lib/docker";
import { verifyAssetToken } from "@/lib/asset-token";
import { loadBrandKit } from "@/lib/brand/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /brand-assets/<assetId>?t=<token>  (PUBLIC — token auth, no cookie)
 *
 * Streams a brand asset's bytes from the owning user's container. This is the
 * public proxy Canva's servers fetch during `upload-asset-from-url`: the token
 * embeds the username + asset id and is HMAC-signed with the session secret,
 * so Canva doesn't need the user's session cookie.
 *
 * Resolution: token → username → user row → container → brand.json → asset.path
 * → bytes. Returns 401 for bad/missing tokens, 404 for unknown assets/files.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await ctx.params;
  const url = new URL(_req.url);
  const token = url.searchParams.get("t") ?? "";

  const payload = verifyAssetToken(token);
  if (!payload || payload.a !== assetId) {
    return new Response("unauthorized", { status: 401 });
  }

  // Resolve the owning user by username.
  const user = db()
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(payload.u) as UserRow | undefined;
  if (!user) return new Response("not found", { status: 404 });

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return new Response("container not ready", { status: 503 });
  }

  // Find the asset metadata in the user's brand kit.
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
      // Assets are immutable per-id (a new upload gets a new uuid). Allow
      // caching so Canva's re-fetches are cheap, but keep it short to be safe.
      "Cache-Control": "private, max-age=300",
    },
  });
}
