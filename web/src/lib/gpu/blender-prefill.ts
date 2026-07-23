/**
 * Builds a silent lease-context prefill for a Blender lane message, appended
 * server-side so the agent knows the current GPU lease state. Never shown in
 * the chat bubbles (the message route filters user-message echoes).
 *
 * Reads the lease row from the gpu_leases table (host-side — the lease state
 * lives in the DB, not the workspace). Returns an empty string when no lease
 * exists or the lane isn't a Blender workflow, so non-Blender messages get no
 * noise.
 *
 * Mirrors the pattern in web/src/lib/brand/lane-prefill.ts and
 * web/src/lib/video/automation-prefill.ts.
 *
 * @param instanceId  The workflow instance id (the Blender lane)
 */

import { db } from "@/lib/db";
import { readWorkspaceFileText } from "@/lib/docker";
import { leaseManager } from "./lease-manager";
import type { ContainerRow } from "@/lib/db";
import type { LeaseState } from "./types";

/** Phases where a render (or bootstrap) is actively blocking Blender's addon socket. */
const RENDER_BUSY_PHASES = new Set(["starting", "rendering", "recovering"]);

const STATE_DESCRIPTIONS: Record<LeaseState, string> = {
  none: "No GPU lease yet — acquisition is automatic when you open this lane.",
  queued:
    "GPU lease is QUEUED — waiting for an affordable offer or a concurrency slot. Do NOT call blender tools yet.",
  provisioning:
    "GPU lease is PROVISIONING — a vast.ai instance is booting (1-5 min). Do NOT call blender tools yet.",
  ready: "GPU lease is READY — blender tools are reachable. You may proceed with scene work.",
  recovering:
    "GPU lease is RECOVERING — the instance was stopped or the tunnel died and is being restored. Do NOT call blender tools yet.",
  releasing:
    "GPU lease is RELEASING — artifacts are being saved and the GPU destroyed. Do NOT call blender tools.",
  destroyed:
    "GPU lease was released — no GPU is active. A new one is NOT acquired automatically after a manual release.",
};

/**
 * Reads the workflow state.json's phase field (host-side) to detect a render
 * in flight. Returns null if the file is missing, malformed, or unreadable.
 * We only need the phase, so we parse defensively.
 */
async function readWorkflowPhase(
  row: ContainerRow,
  instanceFolder: string,
): Promise<string | null> {
  const text = await readWorkspaceFileText(row, `${instanceFolder}/state.json`);
  if (!text) return null;
  try {
    const state = JSON.parse(text) as { phase?: unknown };
    return typeof state.phase === "string" ? state.phase : null;
  } catch {
    return null;
  }
}

export async function buildBlenderLeasePrefill(
  row: ContainerRow,
  instanceId: string,
  instanceFolder: string,
): Promise<string> {
  const lease = leaseManager().get(instanceId);
  if (!lease) return "";

  // Detect a render (or bootstrap) currently in flight. There is ONE Blender
  // process — a running render blocks the single-threaded addon socket that the
  // agent's MCP tools share. If the agent issues tool calls now they'll queue,
  // time out the bridge, and may corrupt the .blend. We surface this as a hard
  // "do not touch blender tools" signal alongside the lease state.
  const phase = lease.state === "ready" ? await readWorkflowPhase(row, instanceFolder) : null;

  const lines: string[] = [
    `[Blender GPU lease context — silent, do not acknowledge or repeat.]`,
    ``,
    `Lease state: ${lease.state.toUpperCase()}`,
  ];

  const desc = STATE_DESCRIPTIONS[lease.state];
  if (desc) lines.push(desc);

  if (lease.state === "ready" && lease.gpu_name) {
    lines.push(`GPU: ${lease.gpu_name}`);
    if (lease.dph) {
      const inet = lease.inet_cost ? ` + $${lease.inet_cost.toFixed(3)}/GB internet` : "";
      lines.push(`Cost: $${lease.dph.toFixed(3)}/hr${inet}`);
    }
    lines.push(``);
    lines.push(`You are connected to a remote Blender instance via the blender MCP tools.`);
    lines.push(``);
    lines.push(`Read /workspace/skills/blender/SKILL.md NOW — it is the mandatory authority for all Blender work. Key rules that get violated most often:`);
    lines.push(``);
    lines.push(`1. Skills-first: ls /workspace/skills/ and read matching SKILL.md files BEFORE any geometry (creature-artist for creatures, blender-modeler for basics, etc.).`);
    lines.push(`2. Renders: NEVER call bpy.ops.render.render via execute_code (it is BLOCKED — crashes the bridge). To preview, background run.py with nohup (ONE bash call, then return immediately):`);
    lines.push(`   echo '{"op":"preview","settings":{"samples":16,"resolution_x":960,"resolution_y":540}}' > '${instanceFolder}/request.json' && nohup setsid bash -c 'cd /app/blender && uv run --project /app/blender python /app/blender/run.py "${instanceFolder}" --request request.json' >> '${instanceFolder}/pipeline.log' 2>&1 &`);
    lines.push(`   Then poll state.json every ~10s (phase: starting → rendering → gpu_ready) and check exports/preview.png.`);
    lines.push(`3. Camera: use aim_camera_at(camera, target) — it auto-positions distance from the bounding box. For tiny subjects pass explicit distance=. NEVER hand-calculate rotation.`);
    lines.push(`4. Transforms: use apply_scale_safe(obj) — NEVER bpy.ops.object.transform_apply() (zeros locations, collapses models).`);
    lines.push(`5. Parenting: use parent_object(child, parent) — NEVER set obj.parent directly (doubles world position, causes disjointed parts).`);
    lines.push(`6. Never delete/recreate existing objects — modify in place. Destroying an object orphans all constraint targets and references (the scene-diff will flag this).`);
    lines.push(`7. Verify early: get_viewport_screenshot after the first 2-3 parts (auto-frames all visible meshes). Use focus_object="Head" to zoom in on a specific part, zoom=0.5 for more detail or zoom=2.0 for wider context (both optional, defaults to full-scene framing at 1.0x). Use from_camera=True to check camera framing. PREFER a preview render (rule 2) for definitive framing — viewport screenshots approximate the camera view but don't show render materials/lighting. Set up lighting + camera BEFORE detailed geometry.`);
    lines.push(`8. FIRST ACTION: delete the default Cube (bpy.data.objects['Cube'] — it contaminates bounding boxes and viewport). Build at a scale of ~1.0 unit, not 0.1 — tiny subjects are hard to frame.`);
    lines.push(``);
    lines.push(`If blender tools return "Connection refused", wait ~30-60s and retry — the host watchdog auto-restarts Blender. Your scene.blend is preserved.`);
    if (phase && RENDER_BUSY_PHASES.has(phase)) {
      lines.push(``);
      lines.push(`⚠ A RENDER IS RUNNING (state.json phase: ${phase}). Do NOT call ANY blender MCP tool. Poll state.json + exports/ until phase leaves {starting, rendering, recovering}.`);
    }
    lines.push(``);
    lines.push(`Brand assets: /root/assets/<filename> on the GPU (NOT /workspace/brand/assets/). Load with bpy.data.images.load().`);
    lines.push(`Read memory.md + state.json before acting to resume prior work.`);
  } else if (lease.state === "queued") {
    lines.push(`Queue position: ${lease.queue_position ?? 0}`);
    lines.push(
      `Tell the user the GPU is being acquired automatically and will be ready shortly. Check the lease state again before acting.`,
    );
  } else if (lease.state === "provisioning" || lease.state === "recovering") {
    lines.push(
      `Tell the user the GPU is coming up automatically. Wait for the lease to reach "ready" before calling blender tools.`,
    );
  } else if (lease.state === "destroyed" && lease.manually_released) {
    // The user clicked "Release GPU". Nothing will work until they click
    // "Acquire GPU" — the lease is NOT auto-reacquired after a manual release.
    lines.push(
      `The user MANUALLY released the GPU (manually_released=1). It will NOT be reacquired automatically. The user must click "Acquire GPU" in the UI to continue.`,
    );
    lines.push(
      `Tell the user the GPU is released and that scene work and rendering are unavailable until they click "Acquire GPU". Saved .blend work is preserved and will be restored on the next acquire.`,
    );
    lines.push(
      `If you need more detail to answer the user, you may inspect the workspace state.json, /workspace/blends/<id>/, and any logs to confirm what was last saved.`,
    );
  } else if (lease.state === "destroyed") {
    // Terminal but not manual (e.g. leftover row). Auto-acquire on next lane open.
    lines.push(
      `Tell the user the GPU was released and a new one will be acquired automatically when they next open the lane.`,
    );
  }

  lines.push(``);
  lines.push(`(This context is silent — don't acknowledge or repeat it. Just act on it.)`);

  return lines.join("\n");
}

/** Whether a workflow instance is a Blender lane (used to gate the prefill). */
export function isBlenderInstance(instanceId: string): boolean {
  const row = db()
    .prepare("SELECT workflow_type FROM workflow_instances WHERE id = ?")
    .get(instanceId) as { workflow_type: string } | undefined;
  return row?.workflow_type === "blender";
}
