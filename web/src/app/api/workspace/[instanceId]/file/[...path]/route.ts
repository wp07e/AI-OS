import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getContainerForUser, readWorkspaceFileBuffer } from "@/lib/docker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workspace/<instanceId>/file/<path>
 *
 * Streams a single file from the workflow instance's workspace folder. Used by
 * canvases to render previews/exports (PNGs, PDFs, rendered HTML). The path is
 * resolved relative to the instance's folder and path-traversal is blocked by
 * requiring the resolved path to start with the instance folder.
 *
 * Auth: instance must belong to the current user. Container must be ready.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ instanceId: string; path: string[] }> },
) {
  const user = await currentUser();
  if (!user) return new Response("unauthorized", { status: 401 });

  const { instanceId, path: segments } = await ctx.params;

  const instance = db()
    .prepare("SELECT folder FROM workflow_instances WHERE id = ? AND user_id = ?")
    .get(instanceId, user.id) as { folder: string } | undefined;
  if (!instance) return new Response("not found", { status: 404 });

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return new Response("container not ready", { status: 503 });
  }

  // Defensive path resolution. `path` is the catch-all [...path] array.
  // Reject anything that tries to escape the instance folder.
  const rel = segments.map(decodeURIComponent).join("/");
  if (rel.includes("..") || rel.startsWith("/")) {
    return new Response("forbidden", { status: 403 });
  }
  const abs = `${instance.folder}/${rel}`;

  const buf = await readWorkspaceFileBuffer(row, abs);
  if (!buf) return new Response("not found", { status: 404 });

  // Infer content type from extension so <img src=...> and iframe embeds work.
  const ext = abs.split(".").pop()?.toLowerCase() ?? "";
  const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";

  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(buf.length),
      // Exports are MUTABLE — edits overwrite them. The canvas appends a
      // cache-buster (?v=<lastUpdated>) so re-fetches happen when the file
      // changes, but we must not tell the browser to serve stale bytes across
      // that change. no-cache → revalidate on every request.
      "Cache-Control": "no-cache",
    },
  });
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  json: "application/json",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
};
