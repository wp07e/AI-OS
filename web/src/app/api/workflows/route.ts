import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { currentUser } from "@/lib/auth";
import { db, type WorkflowInstanceRow } from "@/lib/db";
import { execInContainer, getContainerForUser } from "@/lib/docker";
import { getWorkflow } from "@/lib/workflows/registry";

export const runtime = "nodejs";

/**
 * GET /api/workflows — list the current user's workflow instances, newest first.
 * Used by the WorkRail to populate the drawers.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const instances = db()
    .prepare(
      `SELECT id, user_id, workflow_type, title, folder, status, created_at, updated_at
       FROM workflow_instances
       WHERE user_id = ? AND status = 'active'
       ORDER BY datetime(updated_at) DESC`,
    )
    .all(user.id) as WorkflowInstanceRow[];

  return NextResponse.json({
    instances: instances.map((i) => ({
      id: i.id,
      workflow_type: i.workflow_type,
      title: i.title,
      folder: i.folder,
      status: i.status,
    })),
  });
}

/**
 * POST /api/workflows — create a new workflow instance.
 * Body: { type: string, title?: string }
 *
 * Inserts a workflow_instances row and creates the workspace folder inside the
 * user's container (/workspace/<folder>/<id>) via `docker compose exec`. The
 * folder path is the one contract the skill and canvas both rely on.
 */
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const row = getContainerForUser(user.id);
  if (!row || row.status !== "ready") {
    return NextResponse.json({ error: "container not ready" }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const type = String(body.type ?? "").trim();
  if (!type) return NextResponse.json({ error: "type is required" }, { status: 400 });

  const def = getWorkflow(type);
  if (!def) return NextResponse.json({ error: "unknown workflow type" }, { status: 400 });

  const title = String(body.title ?? `New ${def.label}`).trim().slice(0, 120);
  const id = randomUUID();
  const folder = `/workspace/${def.folder}/${id}`;
  const now = new Date().toISOString();

  // Create the workspace folder as the container's app user so ownership matches
  // what OpenCode expects (it runs as the same user via gosu). mkdir -p is safe
  // if the parent already exists.
  const mk = await execInContainer(
    row,
    ["mkdir", "-p", folder],
    { user: "appuser" },
  );
  if (mk.code !== 0) {
    return NextResponse.json(
      { error: "failed to create workspace folder", detail: mk.stderr.trim() || `exit ${mk.code}` },
      { status: 500 },
    );
  }

  // Seed the instance folder with a per-instance AGENTS.md that tells the agent
  // which instance + folder is active. This is how the agent learns its concrete
  // working context WITHOUT context being injected into user messages (which we
  // learned triggers slow agent tool loops). The agent reads AGENTS.md when it
  // operates in this folder.
  // Build the per-instance AGENTS.md content. The heredoc below uses a quoted
  // delimiter ('AGENTSEOF') so no shell expansion happens on the body — safe
  // even if title/folder contain special chars (they're written literally).
  const agentsMd = `# Active workflow instance

- **Workflow type:** ${def.type}
- **Title:** ${title}
- **Instance folder:** ${folder}
- **Skill:** ${def.skill}

You are working on this instance. Read and write all files for this work under:
\`\`\`
${folder}
\`\`\`
Write state.json, memory.md, and any artifact files (brief.json, exports/, etc.)
there. See /workspace/AGENTS.md for the full environment context.
`;
  // Write via a quoted heredoc so the body is passed literally (no expansion).
  // folder is a uuid-based path under /workspace — safe for single-quoting.
  const writeAgents = await execInContainer(
    row,
    ["sh", "-c", `cat > '${folder}/AGENTS.md' <<'AGENTSEOF'\n${agentsMd}AGENTSEOF\n`],
    { user: "appuser" },
  );
  if (writeAgents.code !== 0) {
    return NextResponse.json(
      { error: "failed to seed instance AGENTS.md", detail: writeAgents.stderr.trim() || `exit ${writeAgents.code}` },
      { status: 500 },
    );
  }

  db()
    .prepare(
      `INSERT INTO workflow_instances (id, user_id, workflow_type, title, folder, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(id, user.id, type, title, folder, now, now);

  const instance = {
    id,
    workflow_type: type,
    title,
    folder,
    status: "active",
  };
  return NextResponse.json({ instance }, { status: 201 });
}
