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
    lines.push(
      `You are connected to a remote Blender instance via the blender MCP tools. Use them directly for scene work (create_object, execute_code, get_render, Poly Haven assets, etc.).`,
    );
    lines.push(
      `MANDATORY FIRST STEP before any modeling: run ls /workspace/skills/ and read every matching SKILL.md before creating or modifying geometry. The 94 technique skills (e.g. creature-artist for creatures/insects/animals — it has an insect anatomy table, blender-modeler for core modeling, procedural-modeling for parametric legs/antennae, hard-surface for machinery, sculpting for organic detail) contain exact anatomy/workflow recipes. Skipping them is the #1 cause of detached parts and failed builds — do NOT begin modeling until you've read the relevant skill(s), and follow the "Modeling methodology" section of /workspace/skills/blender/SKILL.md (skills-first check, one-step-at-a-time, multi-part assembly protocol, ~25-call cap).`,
    );
    lines.push(
      `Footgun reminders (see the "Modeling technique footguns" section of /workspace/skills/blender/SKILL.md): use apply_scale_safe(object) — NOT bpy.ops.object.transform_apply() (it defaults to location=True and zeros every segment to the origin, collapsing multi-part models); use aim_camera_at(camera, target, lens) to frame shots — NEVER hand-calculate camera rotation (the trig fails); call get_viewport_screenshot after the first 2-3 parts are assembled to catch framing/assembly errors before they compound into a wasted render.`,
    );
    lines.push(
      `Workflow after every meaningful change: (1) save via execute_code bpy.ops.wm.save_as_mainfile(filepath="/root/blender/scene.blend"), (2) trigger a quick EEVEE preview render (16 samples, 960x540) by backgrounding run.py so it does NOT block your shell or the Blender socket. CRITICAL: run.py must be launched with nohup+setsid and '&' so it detaches — a foreground run will block the bash tool until its timeout (signal 15) and may contend with the Blender socket. Do it in ONE bash call: echo '{"op":"preview","settings":{"samples":16,"resolution_x":960,"resolution_y":540}}' > '${instanceFolder}/request.json' && nohup setsid bash -c 'cd /app/blender && uv run --project /app/blender python /app/blender/run.py "${instanceFolder}" --request request.json' >> '${instanceFolder}/pipeline.log' 2>&1 &  — then immediately return. Do NOT wait for it in the bash call. (3) poll state.json every ~10s (phase goes starting → rendering → gpu_ready) and the renders[] preview entry at exports/preview.png. The host syncs the preview from the GPU to the workspace within ~5s after gpu_ready. NEVER call bpy.ops.render.render via execute_blender_code for anything but a trivial scene — it goes through the MCP bridge (~120s cap) and will time out, reset the connection, and crash Blender.`,
    );
    lines.push(
      `There is ONE Blender process — your MCP tools and the user's "Render" button share its single-threaded addon socket. Final high-quality renders are owned by the helper script (op:"render"), triggered by the user clicking "Render" in the UI. NEVER trigger a Cycles render or large EEVEE render yourself via MCP: it blocks the socket, times out the bridge, and can corrupt scene.blend. Your only job on a render is to poll state.json + exports/render_*.png every ~15s and report when it finishes.`,
    );
    lines.push(
      `If a blender tool call returns "Connection refused", "Connection reset by peer", or the MCP server reports Blender unreachable, the Blender process may have crashed. A host-side watchdog detects this and auto-restarts Blender within ~30s (it SSHes into the GPU instance, kills stale Blender, relaunches with your saved scene.blend, and restarts the tunnel). Just WAIT ~30-60s and retry — do NOT try to restart it yourself (you can't SSH to the GPU instance, and the web API restart route requires browser auth you don't have). Your scene.blend is preserved across restarts.`,
    );
    if (phase && RENDER_BUSY_PHASES.has(phase)) {
      lines.push(
        `⚠ A RENDER IS CURRENTLY RUNNING INSIDE BLENDER (state.json phase: ${phase}). Do NOT call ANY blender MCP tool right now — the call will queue behind the render, time out the bridge, and may corrupt scene.blend. Poll state.json (phase goes starting → rendering → complete) and exports/render_####.png every ~15s. Resume scene edits only once phase leaves {starting, rendering, recovering}.`,
      );
    }
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
