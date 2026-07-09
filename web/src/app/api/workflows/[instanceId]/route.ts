import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { execInContainer, getContainerForUser } from "@/lib/docker";

export const runtime = "nodejs";

/**
 * PATCH /api/workflows/<instanceId>
 *
 * Renames a workflow instance (lane title).
 * Body: { title: string } — trimmed, max 120 chars, must be non-empty.
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { instanceId } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as { title?: string };
  const title = String(body.title ?? "")
    .trim()
    .slice(0, 120);
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const row = db()
    .prepare(
      "UPDATE workflow_instances SET title = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
    )
    .run(title, instanceId, user.id);

  if (row.changes === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/workflows/<instanceId>
 *
 * Deletes a workflow instance (a "lane") and its associated workspace files:
 *   - Removes the instance's folder inside the container (best-effort), which
 *     holds state.json, brief.json, memory.md, exports/, AGENTS.md, etc.
 *   - Deletes the workflow_instances row. The opencode_sessions row for this
 *     lane is removed automatically via the FOREIGN KEY ON DELETE CASCADE.
 *
 * Auth: the instance must belong to the current user. If the container isn't
 * ready (e.g. stopped), file deletion is skipped but the DB row is still removed
 * so the UI isn't left with an undeletable orphan; any residue files in the
 * workspace volume are harmless.
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { instanceId } = await ctx.params;

  const instance = db()
    .prepare(
      "SELECT id, user_id, folder FROM workflow_instances WHERE id = ? AND user_id = ?",
    )
    .get(instanceId, user.id) as
    | { id: string; user_id: number; folder: string }
    | undefined;
  if (!instance) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Delete the workspace folder inside the container (best-effort).
  //
  // Path-safety guard: only delete paths that are strictly under /workspace/.
  // The folder is a trusted /workspace/<type>/<uuid> path written at instance
  // creation, but this defense-in-depth check ensures a corrupt/abusive row can
  // never coax us into `rm -rf /workspace` (or worse).
  const folder = instance.folder;
  const isSafeWorkspaceChild =
    folder.startsWith("/workspace/") && folder.length > "/workspace/".length;

  if (isSafeWorkspaceChild) {
    const row = getContainerForUser(user.id);
    // Only attempt the in-container rm when the container is actually running;
    // a stopped container can't service `compose exec`, and we'd rather drop
    // the DB row than fail the whole delete because the container is offline.
    if (row && row.status === "ready") {
      const r = await execInContainer(row, ["rm", "-rf", folder], {
        user: "appuser",
      });
      if (r.code !== 0) {
        // Non-fatal: folder may already be gone, or the rm hit a permission
        // issue. Log and continue — the DB row is still removed below.
        console.error(
          `[delete lane] rm -rf ${folder} exited ${r.code}: ${r.stderr.trim()}`,
        );
      }
    }
  } else {
    console.error(
      `[delete lane] refusing to delete unsafe folder path: ${folder}`,
    );
  }

  db()
    .prepare("DELETE FROM workflow_instances WHERE id = ? AND user_id = ?")
    .run(instanceId, user.id);

  return NextResponse.json({ ok: true });
}
