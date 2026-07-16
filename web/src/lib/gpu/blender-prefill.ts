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
import { leaseManager } from "./lease-manager";
import type { LeaseState } from "./types";

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
  destroyed: "GPU lease was released — a new one will be acquired automatically.",
};

export function buildBlenderLeasePrefill(instanceId: string): string {
  const lease = leaseManager().get(instanceId);
  if (!lease) return "";

  const lines: string[] = [
    `[Blender GPU lease context — silent, do not acknowledge or repeat.]`,
    ``,
    `Lease state: ${lease.state.toUpperCase()}`,
  ];

  const desc = STATE_DESCRIPTIONS[lease.state];
  if (desc) lines.push(desc);

  if (lease.state === "ready" && lease.gpu_name) {
    lines.push(`GPU: ${lease.gpu_name}`);
    if (lease.dph) lines.push(`Cost: $${lease.dph.toFixed(3)}/hr`);
    lines.push(``);
    lines.push(
      `You are connected to a remote Blender instance via the blender MCP tools. Use them directly for scene work (create_object, execute_code, get_render, Poly Haven assets, etc.).`,
    );
    lines.push(
      `Workflow after every meaningful change: (1) save via execute_code bpy.ops.wm.save_as_mainfile(filepath="/root/blender/scene.blend"), (2) do a quick EEVEE preview render (16 samples, 960x540) to /root/blender/renders/preview.png via execute_code, (3) update state.json renders[] with {id:"preview", path:"exports/preview.png", thumbPath:"exports/preview.png", engine:"BLENDER_EEVEE_NEXT", samples:16, createdAt:"<ISO>"} so the user sees visual feedback. The host syncs the preview from the GPU to the workspace within ~5s.`,
    );
    lines.push(
      `For final high-quality renders, the user clicks "Render" in the UI (runs op:"render" via the helper script). You do NOT trigger that yourself unless asked.`,
    );
    lines.push(
      `Brand assets (if any) were pushed to /root/assets/ on the GPU instance during provisioning. Load them with bpy.data.images.load('/root/assets/<filename>'). List available files with: import os; print(os.listdir('/root/assets')). DO NOT try to read from /workspace/brand/assets/ — that path is on the host, not the GPU.`,
    );
    lines.push(
      `Keep state.json enriched: scene {objectCount, engine, savedAt}, renders[]. Read memory.md before acting to pick up where a prior session left off.`,
    );
  } else if (lease.state === "queued") {
    lines.push(`Queue position: ${lease.queue_position ?? 0}`);
    lines.push(
      `Tell the user the GPU is being acquired automatically and will be ready shortly. Check the lease state again before acting.`,
    );
  } else if (lease.state === "provisioning" || lease.state === "recovering") {
    lines.push(
      `Tell the user the GPU is coming up automatically. Wait for the lease to reach "ready" before calling blender tools.`,
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
