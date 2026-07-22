/**
 * Deterministic in-memory mock of the vast.ai client.
 *
 * Used ONLY when `AIOS_TEST_MOCK_VAST=1` is set (see vast.ts). Lets the
 * Next.js dev server (booted by Playwright) and in-process route-handler tests
 * exercise the full GPU lease state machine — acquire → provisioning → ready,
 * release → destroyed — without renting real hardware.
 *
 * Configurable timing knobs (env-overridable so individual tests can stretch a
 * window on purpose, e.g. Test 3's "during release" assertion):
 *
 *   AIOS_TEST_VAST_BOOT_MS   — ms for an instance to go booting→running (def 200)
 *   AIOS_TEST_VAST_DESTROY_MS — ms for destroy to confirm (def 100). This is the
 *                              window in which a `destroyed`-row background task
 *                              is still in flight.
 *
 * Failure-injection knobs (all default OFF):
 *   AIOS_TEST_VAST_FAIL_CREATE=1  — createInstance rejects (no instance created)
 *   AIOS_TEST_VAST_FAIL_DESTROY=1 — destroyInstance rejects (lease manager's
 *                                    destroy-retry must still complete the row)
 *
 * State is held in a module-level Map so it survives across requests within a
 * single server process. `resetMockVastState()` wipes it (for test isolation).
 */

import type {
  CreateInstanceOptions,
  Instance,
  InstanceState,
  Offer,
  SshTarget,
} from "./types";
import type { VastClient } from "./vast";

// ── Config ──────────────────────────────────────────────────────────────────

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const BOOT_MS = envInt("AIOS_TEST_VAST_BOOT_MS", 200);
const DESTROY_MS = envInt("AIOS_TEST_VAST_DESTROY_MS", 100);
const FAIL_CREATE = process.env.AIOS_TEST_VAST_FAIL_CREATE === "1";
const FAIL_DESTROY = process.env.AIOS_TEST_VAST_FAIL_DESTROY === "1";

// ── In-memory instance store ────────────────────────────────────────────────

/**
 * The mock models a transient "booting" phase (booting→running after BOOT_MS)
 * that the real vast.ai CLI folds into "loading". InstanceState doesn't include
 * "booting", so MockInstance widens cur_state to include it. The public methods
 * narrow back to InstanceState when returning to callers.
 */
type MockState = InstanceState | "booting";

interface MockInstance {
  id: number;
  cur_state: MockState;
  gpu_name?: string;
  dph_total?: number;
  createdAt: number;
  destroyedAt: number | null;
}

const instances = new Map<number, MockInstance>();
let nextId = 1000;

const SSH_KEYS = new Map<number, string>();
let nextKeyId = 9000;

/**
 * Deterministic distinct machine_ids for mock offers, cycled so each
 * createInstance gets a different physical host unless excluded. Tests rely on
 * this to exercise the escalation ladder (same machine fails twice → reboot →
 * blacklist → different machine acquired).
 */
const MOCK_MACHINE_IDS = [7000, 7001, 7002];
let nextOfferId = 100;

/**
 * Reset all in-memory state. Tests call this in beforeEach (via the test
 * helper) so each test starts from a clean slate. No-op in production since
 * the mock isn't loaded there.
 */
export function resetMockVastState(): void {
  instances.clear();
  SSH_KEYS.clear();
  nextId = 1000;
  nextKeyId = 9000;
  nextOfferId = 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createMockVastClient(): VastClient {
  return {
    async showUser(): Promise<unknown> {
      return { api_key: "mock-key", credit: 100.0, mock: true };
    },

    async searchOffers(opts: { excludeMachineIds?: number[] } = {}): Promise<Offer[]> {
      // Return one offer per mock machine_id, skipping any that are excluded
      // (blacklisted). Each offer carries a distinct machine_id so the escalation
      // ladder can be exercised deterministically: the same offer isn't reused
      // (offers are single-use), but the same machine_id repeats across offers
      // until blacklisted.
      const exclude = new Set((opts.excludeMachineIds ?? []).map(Number));
      const offers: Offer[] = [];
      for (const machineId of MOCK_MACHINE_IDS) {
        if (exclude.has(machineId)) continue;
        offers.push({
          id: nextOfferId++,
          machine_id: machineId,
          gpu_name: "RTX 4060 Ti",
          num_gpus: 1,
          dph_total: 0.081,
          dlperf: 50,
          dlperf_per_dphtotal: 617,
          cuda_max_good: 12.6,
          rentable: true,
        });
      }
      return offers;
    },

    async createInstance(opts: CreateInstanceOptions): Promise<{ id: number }> {
      if (FAIL_CREATE) {
        throw new Error("[mock-vast] createInstance failed (AIOS_TEST_VAST_FAIL_CREATE=1)");
      }
      const id = nextId++;
      instances.set(id, {
        id,
        // Born "booting" (provisioning). Transition to running after BOOT_MS.
        // The lease manager polls getInstance / waitForRunning.
        cur_state: "booting",
        gpu_name: "RTX 4060 Ti",
        dph_total: 0.081,
        createdAt: Date.now(),
        destroyedAt: null,
      });
      // Reference opts.image/label so unused-var lint doesn't fire; the real
      // client would pass these to vastai.
      void opts.image;
      void opts.label;
      return { id };
    },

    async getInstance(id: number): Promise<Instance | null> {
      const inst = instances.get(id);
      if (!inst || inst.destroyedAt !== null) return null;
      // Promote booting→running once BOOT_MS has elapsed since creation.
      if (inst.cur_state === "booting" && Date.now() - inst.createdAt >= BOOT_MS) {
        inst.cur_state = "running";
      }
      return { ...inst, cur_state: inst.cur_state as InstanceState };
    },

    async listInstances(): Promise<Instance[]> {
      const out: Instance[] = [];
      for (const inst of instances.values()) {
        if (inst.destroyedAt !== null) continue;
        if (inst.cur_state === "booting" && Date.now() - inst.createdAt >= BOOT_MS) {
          inst.cur_state = "running";
        }
        out.push({ ...inst, cur_state: inst.cur_state as InstanceState });
      }
      return out;
    },

    async waitForRunning(id: number, timeoutMs = 60_000): Promise<Instance> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const inst = await this.getInstance(id);
        if (!inst) throw new Error(`[mock-vast] instance ${id} vanished during waitForRunning`);
        if (inst.cur_state === "running") return inst;
        await sleep(20);
      }
      throw new Error(`[mock-vast] instance ${id} did not reach running within ${timeoutMs}ms`);
    },

    async stopInstance(id: number): Promise<void> {
      const inst = instances.get(id);
      if (inst) inst.cur_state = "paused";
    },

    async startInstance(id: number): Promise<void> {
      const inst = instances.get(id);
      if (inst) inst.cur_state = "running";
    },

    async rebootInstance(id: number): Promise<void> {
      // Reboot = docker stop+start: data preserved, but the instance goes back
      // through the boot phase (booting→running after BOOT_MS). Mirrors the real
      // vastai reboot semantics so the escalation ladder's post-reboot init wait
      // is exercised realistically.
      const inst = instances.get(id);
      if (inst && inst.destroyedAt === null) {
        inst.cur_state = "booting";
        inst.createdAt = Date.now();
      }
    },

    async destroyInstance(id: number): Promise<void> {
      if (FAIL_DESTROY) {
        throw new Error("[mock-vast] destroyInstance failed (AIOS_TEST_VAST_FAIL_DESTROY=1)");
      }
      // Simulate the brief window where destroy is in-flight. The lease
      // manager's background release path awaits this; the reaper also
      // tolerates a process death mid-destroy.
      await sleep(DESTROY_MS);
      const inst = instances.get(id);
      if (inst) inst.destroyedAt = Date.now();
    },

    async sshUrl(id: number): Promise<SshTarget | null> {
      const inst = instances.get(id);
      if (!inst || inst.destroyedAt !== null) return null;
      return { host: "127.0.0.1", port: 22000 + (id % 1000) };
    },

    async createSshKey(publicKey: string): Promise<{ id: number }> {
      const id = nextKeyId++;
      SSH_KEYS.set(id, publicKey);
      return { id };
    },

    async deleteSshKey(id: number): Promise<void> {
      SSH_KEYS.delete(id);
    },

    async attachSshKey(_instanceId: number, _publicKey: string): Promise<void> {
      // No-op: the mock doesn't model authorized_keys. Lease manager's release
      // path still calls this; we just accept it.
    },

    async listSshKeys(): Promise<Array<{ id: number; public_key: string }>> {
      return [...SSH_KEYS.entries()].map(([id, public_key]) => ({ id, public_key }));
    },

    async instanceLogs(_id: number, _tail = 30): Promise<string> {
      // Plausible provisioning log lines so the GET /lease boot-logs panel has
      // something to render during the provisioning phase.
      return "[mock-vast] onstart: starting blender-mcp...\n[mock-vast] blender-mcp-ready\n";
    },
  };
}
