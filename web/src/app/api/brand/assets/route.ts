import { randomUUID } from "node:crypto";
import { currentUser } from "@/lib/auth";
import {
  getContainerForUser,
  ensureWorkspaceDir,
  writeWorkspaceFileBuffer,
} from "@/lib/docker";
import { loadBrandKit, saveBrandKit, BRAND_ASSETS_DIR } from "@/lib/brand/store";
import type { AssetCategory, BrandAsset } from "@/lib/brand/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_CATEGORIES: AssetCategory[] = ["logo", "photo", "component", "icon"];

/** Extension → MIME, for stored metadata + serving. Images only. */
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/**
 * POST /api/brand/assets — uploads one image asset into the brand library.
 *
 * Multipart form fields:
 *   - file:      the binary (required; image MIME only)
 *   - category:  "logo" | "photo" | "component" | "icon" (required)
 *   - label:     optional display label (defaults to the filename)
 *
 * Stores the bytes at /workspace/brand/assets/<uuid>.<ext>, appends a metadata
 * row to brand.json's assets[], and returns the updated brand kit.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return new Response("container not ready", { status: 503 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  const category = String(form.get("category") ?? "");
  const label = form.get("label") ? String(form.get("label")) : "";

  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: "missing or empty 'file'" }, { status: 400 });
  }
  if (!VALID_CATEGORIES.includes(category as AssetCategory)) {
    return Response.json(
      { error: `invalid category (got ${category || "none"})` },
      { status: 400 },
    );
  }

  // Derive a safe extension from the filename; reject anything we can't map to
  // an image MIME. This also guards against path traversal in the stored path.
  const ext = sanitizeExt(file.name);
  if (!ext || !(ext in MIME_BY_EXT)) {
    return Response.json(
      { error: "unsupported file type (use png, jpg, gif, webp, or svg)" },
      { status: 400 },
    );
  }

  const id = randomUUID();
  const path = `${BRAND_ASSETS_DIR}/${id}.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  await ensureWorkspaceDir(row, BRAND_ASSETS_DIR);
  await writeWorkspaceFileBuffer(row, path, bytes);

  const asset: BrandAsset = {
    id,
    category: category as AssetCategory,
    filename: file.name,
    path,
    mime: MIME_BY_EXT[ext],
    size: bytes.length,
    uploaded_at: new Date().toISOString(),
    label: label || file.name,
  };

  const kit = await loadBrandKit(row);
  kit.assets = [...kit.assets, asset];
  const saved = await saveBrandKit(row, kit);

  return Response.json({ brand: saved, asset }, { status: 201 });
}

/** Lowercases and validates the extension from a filename. Returns "" if invalid. */
function sanitizeExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "";
  const ext = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : "";
}
