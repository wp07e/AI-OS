import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { leaseManager } from "@/lib/gpu/lease-manager";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * POST /api/workspace/<instanceId>/blender/restart
 *
 * Restart Blender in-place on the GPU instance when the Blender process has
 * crashed (segfault) but the vast.ai instance is still running. The agent
 * calls this via curl when it detects connection-refused/reset on blender MCP
 * tool calls. The watchdog also calls the same underlying restartBlender()
 * automatically on its 10s tick, so this route is the agent-triggered path.
 *
 * SSHes into the running instance, kills stale Blender, relaunches with the
 * saved scene.blend (preserving the agent's last-saved work), and polls until
 * the add-on socket responds. Sets lease state to "recovering" during the
 * restart so the prefill tells the agent to wait, then flips to "ready".
 *
 * Prerequisite: the lease must be "ready" or "recovering" (a prior restart
 * in flight). Returns 409 if the lease isn't active.
 */

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { instanceId } = await ctx.params;

  // ── Validate instance ────────────────────────────────────────────────────
  const instance = db()
    .prepare(
      "SELECT id, user_id, workflow_type FROM workflow_instances WHERE id = ? AND user_id = ?",
    )
    .get(instanceId, user.id) as
    | { id: string; user_id: number; workflow_type: string }
    | undefined;
  if (!instance) {
    return NextResponse.json({ error: "workflow instance not found" }, { status: 404 });
  }
  if (instance.workflow_type !== "blender") {
    return NextResponse.json(
      { error: `instance is not a blender workflow (got ${instance.workflow_type})` },
      { status: 400 },
    );
  }

  // ── Validate lease ───────────────────────────────────────────────────────
  const lease = leaseManager().get(instanceId);
  if (!lease) {
    return NextResponse.json({ error: "no GPU lease for this instance" }, { status: 409 });
  }
  if (lease.state !== "ready" && lease.state !== "recovering") {
    return NextResponse.json(
      { error: `GPU lease is ${lease.state}, expected ready/recovering` },
      { status: 409 },
    );
  }

  // ── Restart Blender (serialized via withLock inside restartBlender) ──────
  try {
    const result = await leaseManager().restartBlender(instanceId);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "Blender restart failed" },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, message: "Blender restarted; scene preserved." });
  } catch (e) {
    return NextResponse.json(
      { error: `Blender restart failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
