/**
 * vast.ai CLI client wrapper.
 *
 * Shells out to the `vastai` CLI (installed on the host) with `--raw` JSON
 * output, parsing the result into typed objects. This mirrors how the project
 * already shells out to `docker compose` (see lib/docker.ts) — same spawn
 * pattern, same "parse stdout" approach.
 *
 * The transport is injectable (see `Transport`) so unit tests mock the CLI
 * without spawning real processes; integration tests use the real CLI gated on
 * `VAST_API_KEY`.
 *
 * Key vast-cli gotchas baked in:
 *   - Offer ids are single-use (one instance per offer id). Re-search on create
 *     failure if the offer is stale.
 *   - `gpu_name` query strings replace spaces with underscores ("RTX_4060_Ti").
 *   - RTX 5-series (5060/5060 Ti) require cuda_max_good >= 12.8 or CUDA apps
 *     fail at runtime even though the instance boots.
 *   - `stop` != `destroy`: only `destroy` stops storage billing. `stop` pauses
 *     compute but preserves disk.
 */

import { spawn } from "node:child_process";
import type {
  CreateInstanceOptions,
  Instance,
  InstanceState,
  Offer,
  SearchOffersOptions,
  SshTarget,
} from "./types";

// ── Configurable constants ─────────────────────────────────────────────────

/** GPU models the Blender workflow is allowed to rent. */
export const ALLOWED_GPUS = [
  "RTX 4060",
  "RTX 4060 Ti",
  "RTX 5060",
  "RTX 5060 Ti",
  "RTX A4000",
] as const;

/**
 * RTX 5-series GPUs require CUDA 12.8+ on the host or CUDA apps fail at runtime
 * even though the instance boots. Mapped from display name.
 */
const MIN_CUDA_BY_GPU: Record<string, number> = {
  "RTX 5060": 12.8,
  "RTX 5060 Ti": 12.8,
};

/** Default $/hr cap (overridable via GPU_MAX_DPH env). */
export const DEFAULT_MAX_DPH = Number(process.env.GPU_MAX_DPH ?? 0.09);

/** Default max concurrent GPU instances platform-wide. */
export const DEFAULT_MAX_CONCURRENT = Number(process.env.GPU_MAX_CONCURRENT ?? 5);

/** Default idle lease timeout before auto-release (10 min). */
export const DEFAULT_IDLE_TIMEOUT_MS = Number(process.env.GPU_IDLE_TIMEOUT_MS ?? 10 * 60 * 1000);

/** The CUDA image used for GPU instances. */
export const DEFAULT_GPU_IMAGE =
  process.env.GPU_IMAGE ?? "nvidia/cuda:12.4.1-runtime-ubuntu22.04";

/** Base image disk size (GB). Storage is billed until destroy; keep it tight. */
export const DEFAULT_DISK_GB = Number(process.env.GPU_DISK_GB ?? 50);

/**
 * Default geolocation filter: restrict offers to these 2-letter country codes.
 * Set GPU_GEOLOCATIONS as a comma-separated string in .env (e.g.
 * "TW,JP,KR,SG"). Leave empty/unset for worldwide (no filter).
 *
 * For users far from US datacenters (e.g. Asia), filtering to nearby countries
 * dramatically improves SSH tunnel stability — long-distance SSH connections
 * are frequently dropped by intermediate hosts, causing the blender-mcp socket
 * to appear dead.
 */
const ENV_GEO = process.env.GPU_GEOLOCATIONS;
export const DEFAULT_GEOLOCATIONS: readonly string[] = ENV_GEO
  ? ENV_GEO.split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length === 2)
  : [];

// ── Transport ──────────────────────────────────────────────────────────────

/** Result of a CLI invocation. */
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The transport executes `vastai <args>` and returns the raw result. The
 * default impl spawns the real CLI; tests inject a mock.
 */
export type Transport = (args: string[]) => Promise<CliResult>;

/** Default transport: spawns the real `vastai` CLI on the host. */
export const defaultTransport: Transport = (args) =>
  new Promise((resolveP, reject) => {
    const proc = spawn("vastai", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => resolveP({ code: code ?? 0, stdout, stderr }));
  });

// ── Errors ─────────────────────────────────────────────────────────────────

export class VastError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "VastError";
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert a GPU display name ("RTX 4060 Ti") to the vast query form
 * ("RTX_4060_Ti") — spaces become underscores, per vast-cli query syntax.
 */
export function gpuNameToQuery(displayName: string): string {
  return displayName.replace(/\s+/g, "_");
}

/** Minimum CUDA version required for a given GPU model. */
export function minCudaFor(gpu: string): number {
  return MIN_CUDA_BY_GPU[gpu] ?? 12.0;
}

/** Run vastai and parse `--raw` JSON; throw a VastError on non-zero exit. */
async function runJson<T>(transport: Transport, args: string[]): Promise<T> {
  const res = await transport(args);
  if (res.code !== 0) {
    throw new VastError(
      `vastai ${args.join(" ")} exited ${res.code}`,
      res.code,
      res.stderr.trim(),
    );
  }
  try {
    return JSON.parse(res.stdout) as T;
  } catch (e) {
    throw new VastError(
      `vastai ${args.join(" ")} returned non-JSON output: ${(e as Error).message}`,
      res.code,
      res.stdout.slice(0, 500),
    );
  }
}

// ── API ────────────────────────────────────────────────────────────────────

export interface VastClient {
  /** Show account / balance — also validates the API key. */
  showUser(transport?: Transport): Promise<unknown>;
  /** Search rentable offers matching the options, cheapest-best first. */
  searchOffers(opts?: SearchOffersOptions, transport?: Transport): Promise<Offer[]>;
  /** Rent an instance from an offer id. Returns the new instance id. */
  createInstance(opts: CreateInstanceOptions, transport?: Transport): Promise<{ id: number }>;
  /** Get a single instance's current state. */
  getInstance(id: number, transport?: Transport): Promise<Instance | null>;
  /** List all instances. */
  listInstances(transport?: Transport): Promise<Instance[]>;
  /** Poll until cur_state === "running" (or error/timeout). */
  waitForRunning(id: number, timeoutMs?: number, transport?: Transport): Promise<Instance>;
  /** Pause compute (data preserved; storage still billed). */
  stopInstance(id: number, transport?: Transport): Promise<void>;
  /** Resume a paused instance (re-runs onstart). */
  startInstance(id: number, transport?: Transport): Promise<void>;
  /**
   * Reboot a running/loaded instance: docker stop+start on the host (data
   * preserved). Cheaper than destroy+re-create, and recovers hosts where the
   * container is stuck but the underlying GPU/driver needs a kick. Used by the
   * lease-manager escalation ladder after repeated init failures on the same
   * machine_id but before blacklisting the host.
   */
  rebootInstance(id: number, transport?: Transport): Promise<void>;
  /** Permanently destroy an instance and stop ALL billing. */
  destroyInstance(id: number, transport?: Transport): Promise<void>;
  /** Parse the ssh url for an instance. */
  sshUrl(id: number, transport?: Transport): Promise<SshTarget | null>;
  /** Register an SSH public key on the vast.ai account. Returns the key id. */
  createSshKey(publicKey: string, transport?: Transport): Promise<{ id: number }>;
  /** Remove an SSH key from the vast.ai account. */
  deleteSshKey(id: number, transport?: Transport): Promise<void>;
  /** Attach a registered SSH key to a specific instance (pushes to authorized_keys). */
  attachSshKey(instanceId: number, publicKey: string, transport?: Transport): Promise<void>;
  /** List registered SSH keys. */
  listSshKeys(transport?: Transport): Promise<Array<{ id: number; public_key: string }>>;
  /** Fetch the tail of an instance's container logs (the onstart script output). */
  instanceLogs(id: number, tail?: number, transport?: Transport): Promise<string>;
}

// ── searchOffers query builder (exported for unit testing) ─────────────────

/**
 * Build the vast search-offers query expression for the given options.
 * The query uses `=`, `&`, `|`, and quoted `"op value"` comparisons. GPU names
 * are space→underscore; the cap uses `"dph_total <= X"`; CUDA requirements come
 * from MIN_CUDA_BY_GPU.
 */
/**
 * Build a vast search-offers query for a SINGLE GPU model. vastai 1.4.x does
 * NOT support OR'd gpu_name clauses (the `|` syntax causes "Unconsumed text"
 * errors), so we search each GPU separately and merge in searchOffers.
 *
 * The CUDA floor is per-GPU (12.8 for 5-series, 12.0 otherwise) so a 5060
 * offer that under-reports CUDA is correctly rejected while a 4060 offer passes.
 */
export function buildSearchQuery(
  gpu: string,
  opts: SearchOffersOptions = {},
): string {
  const maxDph = opts.maxDph ?? DEFAULT_MAX_DPH;
  const cudaFloor = opts.minCuda ?? minCudaFor(gpu);
  // NOTE: vastai's query parser does NOT accept spaces inside comparison
  // values. Use the no-space form `dph_total<=0.09`.
  const parts: string[] = [
    `gpu_name=${gpuNameToQuery(gpu)}`,
    `dph_total<=${maxDph}`,
    `cuda_max_good>=${cudaFloor}`,
    `verified=${opts.verified ?? true ? "true" : "false"}`,
  ];
  if (opts.minReliability !== undefined) parts.push(`reliability2>=${opts.minReliability}`);
  if (opts.minInetDown !== undefined) parts.push(`inet_down>=${opts.minInetDown}`);
  if (opts.minGpuRam !== undefined) parts.push(`gpu_ram>=${opts.minGpuRam}`);
  // Geolocation: restrict to specified country codes. Uses vastai's `in`
  // operator: geolocation in [TW,JP,KR]. Empty array = no filter (worldwide).
  if (opts.geolocations && opts.geolocations.length > 0) {
    parts.push(`geolocation in [${opts.geolocations.join(",")}]`);
  }

  return parts.join(" ");
}

// ── Client factory ─────────────────────────────────────────────────────────

/** Create a VastClient. `baseTransport` is the default transport for calls. */
export function createVastClient(baseTransport: Transport = defaultTransport): VastClient {
  const ensureKey = (): string | null => process.env.VAST_API_KEY ?? null;

  return {
    async showUser(transport = baseTransport) {
      return runJson(transport, ["show", "user", "--raw"]);
    },

    async searchOffers(opts = {}, transport = baseTransport) {
      // vastai 1.4.x does NOT support OR'd gpu_name clauses, so we search each
      // GPU model separately and merge the results.
      const gpus = opts.gpuModels ?? ALLOWED_GPUS;
      // Apply default geolocation filter if the caller didn't override it.
      const mergedOpts = {
        ...opts,
        geolocations: opts.geolocations ?? DEFAULT_GEOLOCATIONS,
      };
      const perGpuLimit = Math.ceil((opts.limit ?? 10) / gpus.length) + 2;
      const allOffers: Offer[] = [];
      for (const gpu of gpus) {
        const query = buildSearchQuery(gpu, mergedOpts);
        const args = [
          "search",
          "offers",
          query,
          "-t",
          opts.type ?? "on_demand",
          "--order",
          opts.orderBy ?? "dlperf_per_dphtotal-",
          "--limit",
          String(perGpuLimit),
          "--raw",
        ];
        try {
          const offers = await runJson<Offer[]>(transport, args);
          allOffers.push(...offers);
        } catch {
          // A single GPU search failure (e.g. no offers for that model) is
          // non-fatal — other models may still have offers.
        }
      }
      // Defensive re-filter: enforce the cap and per-GPU CUDA floor in code.
      // Also exclude any blacklisted physical hosts (machine_id) so a known-bad
      // machine that fails init repeatedly is never re-picked. vastai's query DSL
      // has no "machine_id not in (...)" operator, so the exclusion is in code.
      const maxDph = opts.maxDph ?? DEFAULT_MAX_DPH;
      const allowed = new Set(gpus.map((g) => g.toLowerCase()));
      const exclude = new Set((opts.excludeMachineIds ?? []).map(Number));
      const filtered = allOffers.filter((o) => {
        if (o.dph_total > maxDph) return false;
        const gpuFloor = minCudaFor(o.gpu_name);
        if ((o.cuda_max_good ?? 0) < gpuFloor) return false;
        if (!allowed.has((o.gpu_name ?? "").toLowerCase())) return false;
        if (o.machine_id != null && exclude.has(o.machine_id)) return false;
        return true;
      });
      // Sort by perf-per-dollar descending (best value first), then by price.
      // Sort by perf-per-dollar descending (best value first), then by price.
      // NOTE: the vastai field is dlperf_per_dphtotal, NOT dlperf_usd_per_hour.
      filtered.sort(
        (a, b) =>
          (b.dlperf_per_dphtotal ?? 0) - (a.dlperf_per_dphtotal ?? 0) ||
          (a.dph_total ?? 0) - (b.dph_total ?? 0),
      );
      return filtered.slice(0, opts.limit ?? 10);
    },

    async createInstance(opts, transport = baseTransport) {
      if (!ensureKey()) throw new VastError("VAST_API_KEY not set", 1, "");
      const args = [
        "create",
        "instance",
        String(opts.offerId),
        "--image",
        opts.image,
        "--disk",
        String(opts.diskGb ?? DEFAULT_DISK_GB),
        "--ssh",
        "--direct",
        "--force",
      ];
      // onstart: vastai's --onstart takes a FILENAME, --onstart-cmd takes inline
      // content. We pass inline content since the script is generated by the host.
      if (opts.onstart) args.push("--onstart-cmd", opts.onstart);
      if (opts.label) args.push("--label", opts.label);
      // Environment variables: vastai expects --env '-e KEY=VAL -e KEY2=VAL2'
      if (opts.env && Object.keys(opts.env).length > 0) {
        const envStr = Object.entries(opts.env)
          .map(([k, v]) => `-e ${k}=${v}`)
          .join(" ");
        args.push("--env", envStr);
      }
      // For interruptible instances, --bid_price sets the per-hour bid.
      if (opts.type === "interruptible" && opts.price !== undefined) {
        args.push("--bid_price", String(opts.price));
      }
      // create instance prints a JSON-ish confirmation; the id is the integer.
      const res = await transport(args);
      if (res.code !== 0) {
        throw new VastError(
          `create instance failed: ${res.stderr.trim() || res.stdout.trim()}`,
          res.code,
          res.stderr,
        );
      }
      // Vast prints e.g. {'success': True, 'action': 'start', ...} or
      // Allocated ID: 12345. Extract the first integer >= 1 from the output.
      const m = res.stdout.match(/(?:ID|id)["':\s]+(\d+)|(\d{5,})/);
      const id = m ? Number(m[1] ?? m[2]) : NaN;
      if (!Number.isFinite(id) || id < 1) {
        throw new VastError(
          `could not parse instance id from output: ${res.stdout.slice(0, 200)}`,
          res.code,
          res.stdout,
        );
      }
      return { id };
    },

    async getInstance(id, transport = baseTransport) {
      const list = await runJson<Instance[]>(transport, ["show", "instances", "--raw"]);
      return list.find((i) => i.id === id) ?? null;
    },

    async listInstances(transport = baseTransport) {
      return runJson<Instance[]>(transport, ["show", "instances", "--raw"]);
    },

    async waitForRunning(id, timeoutMs = 5 * 60 * 1000, transport = baseTransport) {
      const deadline = Date.now() + timeoutMs;
      // Poll interval: 5s in production, but overridable via env for tests
      // (the mocked transport returns instantly, so a shorter interval keeps
      // unit tests well under the 5s vitest timeout).
      const pollInterval = Number(process.env.GPU_POLL_INTERVAL_MS ?? 5000);
      let last: Instance | null = null;
      while (Date.now() < deadline) {
        const inst = await this.getInstance(id, transport);
        last = inst;
        if (!inst) throw new VastError(`instance ${id} vanished`, 1, "");
        if (inst.cur_state === "running") return inst;
        if (inst.cur_state === "error") {
          throw new VastError(`instance ${id} entered error state`, 1, JSON.stringify(inst));
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }
      throw new VastError(
        `instance ${id} did not reach running within ${timeoutMs}ms (last: ${last?.cur_state})`,
        1,
        "",
      );
    },

    async stopInstance(id, transport = baseTransport) {
      const res = await transport(["stop", "instance", String(id), "--raw"]);
      if (res.code !== 0 && !/already|paused/i.test(res.stderr + res.stdout)) {
        throw new VastError(`stop instance ${id} failed`, res.code, res.stderr);
      }
    },

    async startInstance(id, transport = baseTransport) {
      const res = await transport(["start", "instance", String(id), "--raw"]);
      if (res.code !== 0 && !/already|running/i.test(res.stderr + res.stdout)) {
        throw new VastError(`start instance ${id} failed`, res.code, res.stderr);
      }
    },

    async rebootInstance(id, transport = baseTransport) {
      // reboot = docker stop+start on the host; data preserved. vastai prints a
      // Python-dict confirmation (non-JSON), so we check the exit code directly
      // rather than using runJson. Tolerate "already"/"running"/"booting" in the
      // output (an instance already mid-reboot is a no-op success).
      const res = await transport(["reboot", "instance", String(id)]);
      if (res.code !== 0 && !/already|running|booting|reboot/i.test(res.stderr + res.stdout)) {
        throw new VastError(`reboot instance ${id} failed`, res.code, res.stderr);
      }
    },

    async destroyInstance(id, transport = baseTransport) {
      // destroy instance takes -y (skip confirmation). No --force flag in 1.4.x.
      const res = await transport(["destroy", "instance", String(id), "-y"]);
      if (res.code !== 0 && !/not found|already/i.test(res.stderr + res.stdout)) {
        throw new VastError(`destroy instance ${id} failed`, res.code, res.stderr);
      }
    },

    async sshUrl(id, transport = baseTransport) {
      const res = await transport(["ssh-url", String(id), "--raw"]);
      if (res.code !== 0) return null;
      // ssh-url prints ssh://root@1.2.3.4:12345
      const m = res.stdout.match(/ssh:\/\/root@([^:]+):(\d+)/);
      if (!m) return null;
      return { host: m[1], port: Number(m[2]) };
    },

    async createSshKey(publicKey, transport = baseTransport) {
      const res = await transport(["create", "ssh-key", publicKey, "-y"]);
      if (res.code !== 0) {
        throw new VastError(`create ssh-key failed: ${res.stderr || res.stdout}`, res.code, res.stderr);
      }
      // Output: ssh-key created {'success': True, 'key': {'id': 12345, ...}}
      const m = res.stdout.match(/'id':\s*(\d+)/);
      const id = m ? Number(m[1]) : NaN;
      if (!Number.isFinite(id)) {
        throw new VastError(`could not parse ssh-key id from: ${res.stdout.slice(0, 200)}`, res.code, res.stdout);
      }
      return { id };
    },

    async deleteSshKey(id, transport = baseTransport) {
      const res = await transport(["delete", "ssh-key", String(id)]);
      if (res.code !== 0 && !/not found|already/i.test(res.stderr + res.stdout)) {
        throw new VastError(`delete ssh-key ${id} failed`, res.code, res.stderr);
      }
    },

    async attachSshKey(instanceId, publicKey, transport = baseTransport) {
      const res = await transport(["attach", "ssh", String(instanceId), publicKey]);
      // "already associated" is success (idempotent).
      if (res.code !== 0 && !/already/i.test(res.stderr + res.stdout)) {
        throw new VastError(`attach ssh-key to ${instanceId} failed: ${res.stderr || res.stdout}`, res.code, res.stderr);
      }
    },

    async listSshKeys(transport = baseTransport) {
      const res = await transport(["show", "ssh-keys", "--raw"]);
      if (res.code !== 0) return [];
      // show ssh-keys prints a Python-dict-style list. Try JSON first, then
      // fall back to ast-style parsing.
      try {
        const parsed = JSON.parse(res.stdout);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // fall through
      }
      // The CLI prints [{'id': 123, 'public_key': 'ssh-...', ...}] — extract
      // id + public_key pairs with a regex.
      const keys: Array<{ id: number; public_key: string }> = [];
      const idMatches = res.stdout.matchAll(/'id':\s*(\d+).*?'public_key':\s*'([^']+)'/g);
      for (const m of idMatches) {
        keys.push({ id: Number(m[1]), public_key: m[2] });
      }
      return keys;
    },

    async instanceLogs(id, tail = 30, transport = baseTransport) {
      // `vastai logs <id> --tail N --filter <pattern> --full` fetches container
      // logs. The onstart script's log() function prefixes every line with an
      // ISO timestamp in brackets: "[2026-01-15T10:30:00Z] message". sshd
      // connection/auth logs do NOT have this prefix, so filtering for "\\["
      // (an escaped bracket) returns only the onstart provisioning output and
      // excludes the noisy SSH auth spam.
      const res = await transport([
        "logs", String(id),
        "--tail", String(tail),
        "--filter", "\\[",
        "--full",
      ]);
      if (res.code !== 0) return "";
      return res.stdout.trim();
    },
  };
}

/**
 * A shared singleton client. Uses the real CLI transport in production.
 *
 * TEST SEAM — when `AIOS_TEST_MOCK_VAST=1` is set, the singleton is backed by
 * `createMockVastClient()` (see ./vast-mock.ts): a deterministic in-memory
 * implementation with configurable boot/destroy delays and failure injection.
 * This lets the Next.js dev server (booted by Playwright) exercise the full
 * server-side state machine without renting real GPUs. The flag is read ONCE
 * at module load. Direct unit tests of vast.ts are unaffected (they construct
 * `createVastClient(mockTransport)` directly).
 */
export const vast: VastClient =
  process.env.AIOS_TEST_MOCK_VAST === "1"
    ? (() => {
        // Lazy require so production builds never parse the mock module.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { createMockVastClient } = require("./vast-mock");
        return createMockVastClient();
      })()
    : createVastClient();

/** Re-export the state type for convenience. */
export type { InstanceState };
