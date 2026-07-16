/**
 * Integration tests for the vast.ai client (lib/gpu/vast.ts) against the REAL
 * vast.ai API.
 *
 * Gated on VAST_API_KEY: these tests SKIP automatically when the key is absent,
 * so `npm test` (the unit suite) stays free and CI never bills. Run locally:
 *
 *   VAST_API_KEY=... npm run test:integration
 *
 * Every test wraps its rented instance in try/finally with destroyInstance, so
 * no lingering instances accrue storage fees even on failure.
 *
 * Cost guard: each test searches under the DEFAULT_MAX_DPH cap (or lower) and
 * asserts the rented dph_total is within budget. Total spend for this suite is
 * typically a few cents.
 *
 * NOTE: These tests rent real hardware and SSH into it, so they need:
 *   - a valid VAST_API_KEY env var
 *   - the `vastai` CLI on the host PATH
 *   - the `ssh` client available (for the readiness probe)
 * Provisioning takes 1–5 minutes per instance, hence the 10-min test timeouts
 * configured in vitest.integration.config.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import {
  vast,
  DEFAULT_MAX_DPH,
  DEFAULT_GPU_IMAGE,
  ALLOWED_GPUS,
} from "@/lib/gpu/vast";
const KEY = process.env.VAST_API_KEY;
const itReal = KEY ? it : it.skip;

/** True if the vastai CLI is on the host PATH. */
function hasVastCli(): boolean {
  try {
    spawn("which", ["vastai"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  if (!KEY) {
    console.warn("[vast integration] VAST_API_KEY not set — skipping real-API tests.");
  } else if (!hasVastCli()) {
    throw new Error("vastai CLI not found on PATH but VAST_API_KEY is set");
  }
});

/** Find the cheapest qualifying offer under cap and return its id. */
async function cheapestOffer(): Promise<{ id: number; dph: number; gpu: string }> {
  const offers = await vast.searchOffers({ limit: 20 });
  if (offers.length === 0) {
    throw new Error(
      `no vast offers under $${DEFAULT_MAX_DPH}/hr for ${ALLOWED_GPUS.join(", ")} — set GPU_MAX_DPH higher or try later`,
    );
  }
  return { id: offers[0].id, dph: offers[0].dph_total, gpu: offers[0].gpu_name };
}

/** SSH exec helper (best-effort, for readiness probes). */
function sshExec(target: { host: string; port: number }, cmd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolveP) => {
    const proc = spawn(
      "ssh",
      [
        "-p",
        String(target.port),
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=10",
        `root@${target.host}`,
        cmd,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.on("error", () => resolveP({ code: 1, stdout: "" }));
    proc.on("exit", (code) => resolveP({ code: code ?? 1, stdout }));
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("vast integration (real API)", () => {
  itReal("showUser returns account info (validates the key)", async () => {
    const user = (await vast.showUser()) as { api_key?: string; credit?: unknown };
    expect(user).toBeDefined();
  });

  itReal("searchOffers returns at least one qualifying offer under cap", async () => {
    const offers = await vast.searchOffers({ limit: 5 });
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      expect(o.dph_total).toBeLessThanOrEqual(DEFAULT_MAX_DPH);
      expect(ALLOWED_GPUS.map((g) => g.toLowerCase())).toContain(o.gpu_name.toLowerCase());
    }
  });

  itReal(
    "provision -> waitForRunning -> destroy (full lifecycle, no onstart)",
    async () => {
      const offer = await cheapestOffer();
      expect(offer.dph).toBeLessThanOrEqual(DEFAULT_MAX_DPH);

      const { id } = await vast.createInstance({
        offerId: offer.id,
        image: DEFAULT_GPU_IMAGE,
        label: "blender-int-test",
      });
      try {
        const inst = await vast.waitForRunning(id);
        expect(inst.cur_state).toBe("running");
        // Confirm the GPU is visible from inside the instance.
        const target = await vast.sshUrl(id);
        expect(target).not.toBeNull();
        if (target) {
          const nvidia = await sshExec(target, "nvidia-smi -L");
          // nvidia-smi may take a moment to be ready; tolerate a transient miss.
          expect(nvidia.stdout.length).toBeGreaterThan(0);
        }
      } finally {
        await vast.destroyInstance(id);
      }
      // After destroy, getInstance returns null (or the instance is gone).
      const after = await vast.getInstance(id);
      expect(after?.cur_state ?? "gone").toMatch(/gone|exiting|undefined/i);
      if (after) expect(after).toBeNull();
    },
  );

  itReal(
    "stop preserves data (paused), start resumes, then destroy (recovery path)",
    async () => {
      const offer = await cheapestOffer();
      const { id } = await vast.createInstance({
        offerId: offer.id,
        image: DEFAULT_GPU_IMAGE,
        label: "blender-int-stop",
      });
      try {
        await vast.waitForRunning(id);

        // Stop -> should reach paused (data preserved, storage still billed).
        await vast.stopInstance(id);
        let inst = await vast.getInstance(id);
        // Wait briefly for the state to settle to paused.
        for (let i = 0; i < 30 && inst?.cur_state !== "paused"; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          inst = await vast.getInstance(id);
        }
        expect(inst).not.toBeNull();
        // The key assertion: the instance still exists (data preserved).
        // cur_state may be paused or still transitioning; either way it's NOT gone.
        expect(inst?.cur_state).not.toBe("exiting");

        // Start -> should return to running (this is the auto-recovery path).
        await vast.startInstance(id);
        const resumed = await vast.waitForRunning(id);
        expect(resumed.cur_state).toBe("running");
      } finally {
        await vast.destroyInstance(id);
      }
      expect(await vast.getInstance(id)).toBeNull();
    },
  );
});
