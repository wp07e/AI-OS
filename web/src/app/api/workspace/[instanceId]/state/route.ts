import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  getContainerForUser,
  listWorkspaceDir,
  readWorkspaceFileText,
  statWorkspaceFile,
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

  // Stale-phase detection: if the workflow is in a "busy" phase (starting,
  // rendering, recovering) but the lastUpdate timestamp is older than a
  // threshold, the process that wrote it is likely dead (GPU destroyed,
  // run.py killed, container restarted). Surface it as "stale" so the canvas
  // stops showing an infinite spinner. This is a safety net — the happy path
  // transitions through these phases in seconds; only a dead process leaves
  // them stale.
  const BUSY_PHASES = new Set(["starting", "rendering", "recovering", "provisioning"]);
  const STALE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes
  if (BUSY_PHASES.has(state.phase)) {
    const ageMs = Date.now() - new Date(state.lastUpdated).getTime();
    if (Number.isFinite(ageMs) && ageMs > STALE_THRESHOLD_MS) {
      const originalPhase = state.phase;
      state.phase = "stale";
      state.errors = [
        `State "${originalPhase}" hasn't updated in ${Math.round(ageMs / 1000)}s — the GPU may have been lost.`,
        ...state.errors,
      ];
    }
  }

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

  // Robustness: if the agent saved new export files but forgot to bump
  // lastUpdated in state.json, derive a fresher timestamp from the export
  // file mtimes. This guarantees the canvas cache-buster (?v=) changes
  // whenever a PNG is overwritten, so the preview auto-refreshes.
  if (exports.length > 0) {
    const stateEpoch = new Date(state.lastUpdated).getTime() / 1000;
    let youngest = stateEpoch;
    // Stat in parallel — fast even with many slides. NOTE: the exports array
    // contains filenames from INSIDE the exports/ dir (e.g. "preview.png"),
    // so the full path is folder/exports/<name>, not folder/<name>.
    const mtimes = await Promise.all(
      exports.map((name) => statWorkspaceFile(row, `${folder}/exports/${name}`)),
    );
    for (const mtime of mtimes) {
      if (mtime !== null && mtime > youngest) youngest = mtime;
    }
    if (youngest > stateEpoch) {
      state.lastUpdated = new Date(youngest * 1000).toISOString();
    }
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
