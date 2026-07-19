import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getContainerForUser } from "@/lib/docker";
import { leaseManager } from "@/lib/gpu/lease-manager";
import { vast } from "@/lib/gpu/vast";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * GPU lease management for the Blender workflow.
 *
 *   GET    /api/workspace/<instanceId>/blender/lease
 *     → current lease state (or {state:"none"})
 *
 *   POST   /api/workspace/<instanceId>/blender/lease  { resume?: true }
 *     → auto-acquire a GPU lease. Called on lane open. Idempotent. Returns the
 *       lease row (which may be "queued" if no capacity/affordable offer).
 *
 *   DELETE /api/workspace/<instanceId>/blender/lease
 *     → release the lease (sync artifacts, kill tunnel, destroy instance).
 *       Called on lane-leave / idle-timeout / explicit release.
 *
 * Acquisition is ALWAYS automatic from the user's perspective — there is no
 * "ask the user to acquire" path. This POST is the lane-open trigger.
 */

async function resolveInstance(instanceId: string, userId: number) {
  const instance = db()
    .prepare(
      "SELECT id, user_id, workflow_type, folder FROM workflow_instances WHERE id = ? AND user_id = ?",
    )
    .get(instanceId, userId) as
    | { id: string; user_id: number; workflow_type: string; folder: string }
    | undefined;
  if (!instance) return { error: NextResponse.json({ error: "workflow instance not found" }, { status: 404 }) };
  if (instance.workflow_type !== "blender") {
    return {
      error: NextResponse.json(
        { error: `instance is not a blender workflow (got ${instance.workflow_type})` },
        { status: 400 },
      ),
    };
  }
  const container = getContainerForUser(userId);
  if (!container || container.status !== "ready") {
    return { error: NextResponse.json({ error: "container not ready" }, { status: 409 }) };
  }
  return { instance, container };
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { instanceId } = await ctx.params;

  const lease = leaseManager().get(instanceId);
  // Bump last_activity so the idle reaper doesn't release a lease the user is
  // actively viewing (the client polls this GET every 5s). Matches the contract
  // documented in useBlenderState.ts.
  if (lease) leaseManager().touch(instanceId);

  // While booting, stream the GPU instance's provisioning logs so the user sees
  // progress instead of a static "Booting" pill for 5 minutes. Fetched from
  // vast.ai's container logs (the onstart script output).
  let bootLogs: string | undefined;
  if (lease && (lease.state === "provisioning" || lease.state === "recovering") && lease.vast_id) {
    const raw = await vast.instanceLogs(lease.vast_id, 8).catch(() => "");
    // Filter out Docker daemon noise from the early boot phase (before the
    // container exists). The instance id is assigned immediately at creation,
    // but the container takes a few seconds to appear. During that window
    // `vastai logs` returns errors like "No such container: C.<id>" which would
    // confuse users. Return undefined (→ UI shows a busy spinner) until real
    // provisioning output is available.
    if (raw && !/No such container|Error response from daemon|no logs/i.test(raw)) {
      bootLogs = raw;
    }
  }

  return NextResponse.json({
    lease: lease ?? { instance_id: instanceId, state: "none" },
    bootLogs,
  });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { instanceId } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  const resolved = await resolveInstance(instanceId, user.id);
  if ("error" in resolved) return resolved.error;

  // Bump last_activity on every status check (lane is being viewed).
  leaseManager().touch(instanceId);

  // {action:"retry"} — force an immediate queue-pump probe for this one
  // queued lease (the "Retry now" button), bypassing the 20s pump cadence.
  // Distinct from the default acquire path so we don't re-run the full
  // acquire flow on a lease that already has a row.
  if (body.action === "retry") {
    await leaseManager().retryQueued(instanceId);
    return NextResponse.json({ lease: leaseManager().get(instanceId) });
  }

  const resume = body.resume !== false; // default true
  const lease = await leaseManager().acquire({
    instanceId,
    userId: user.id,
    container: resolved.container,
    resume,
  });
  return NextResponse.json({ lease });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ instanceId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { instanceId } = await ctx.params;

  await leaseManager().release(instanceId, "manual");
  return NextResponse.json({ ok: true });
}
