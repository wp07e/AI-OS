import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  getContainerForUser,
  listWorkspaceDir,
  readWorkspaceFileText,
  workspacePathExists,
} from "@/lib/docker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WorkspaceState {
  phase: string;
  lastUpdated: string;
  errors: string[];
  [key: string]: unknown;
}

/**
 * GET /api/workspace/<instanceId>/state
 *
 * Reads the workflow instance's workspace state and returns it for the canvas
 * to poll. The contract:
 *   - state.json is the primary payload. The shell requires phase/lastUpdated/
 *     errors; the rest is workflow-specific and passed through untouched.
 *   - If state.json is absent, returns { phase: "unknown" } (HTTP 200) — the
 *     canvas treats this as "agent hasn't written state yet" and keeps polling.
 *   - Files listing (exports/, brief.json, etc.) is included as a `files`
 *     object so a workflow's useState hook can find assets without a second
 *     round-trip. The generic shape lets each workflow interpret it.
 *
 * Auth: instance must belong to the current user. Container must be ready.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { instanceId } = await ctx.params;

  const instance = db()
    .prepare(
      "SELECT id, user_id, workflow_type, title, folder FROM workflow_instances WHERE id = ? AND user_id = ?",
    )
    .get(instanceId, user.id) as
    | { id: string; user_id: number; workflow_type: string; title: string; folder: string }
    | undefined;
  if (!instance) {
    return NextResponse.json({ error: "workflow instance not found" }, { status: 404 });
  }

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return NextResponse.json({ error: "container not ready" }, { status: 409 });
  }

  const folder = instance.folder;

  // state.json — the primary contract. Non-fatal if missing.
  const stateText = await readWorkspaceFileText(row, `${folder}/state.json`);
  let state: WorkspaceState;
  if (stateText) {
    try {
      state = JSON.parse(stateText) as WorkspaceState;
    } catch {
      state = { phase: "unknown", lastUpdated: new Date().toISOString(), errors: ["state.json was unreadable"] };
    }
  } else {
    state = { phase: "unknown", lastUpdated: new Date().toISOString(), errors: [] };
  }
  // Guarantee the three required fields are present even if the skill omitted them.
  if (typeof state.phase !== "string") state.phase = "unknown";
  if (typeof state.lastUpdated !== "string") state.lastUpdated = new Date().toISOString();
  if (!Array.isArray(state.errors)) state.errors = [];

  // Files present in the workspace folder — lets the canvas discover assets
  // (exports/, brief.json, memory.md, etc.) without separate calls.
  const entries = await listWorkspaceDir(row, folder);
  const files: Record<string, boolean> = {};
  for (const name of entries) files[name] = true;

  // If an exports/ directory exists, enumerate its contents too — the common
  // case (carousel PNGs, newsletter HTML, etc.) so the canvas can render
  // thumbnails without N extra round-trips.
  let exports: string[] = [];
  if (await workspacePathExists(row, `${folder}/exports`)) {
    exports = await listWorkspaceDir(row, `${folder}/exports`);
  }

  return NextResponse.json({
    ...state,
    files,
    exports: exports.map((name) => `exports/${name}`),
    // Folder path echoed so the client can construct /file URLs.
    folder,
    instanceId,
  });
}
