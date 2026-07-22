/**
 * Types for the GPU orchestration layer (vast.ai integration).
 *
 * These mirror the JSON shapes the `vastai` CLI emits with `--raw`. Kept loose
 * (only the fields we actually read) so CLI version drift doesn't break the
 * build — unknown fields pass through untouched.
 */

/** A single rentable machine offer from `vastai search offers --raw`. */
export interface Offer {
  /** Offer id (single-use: can create exactly one instance from it). */
  id: number;
  /**
   * Physical host machine id. Multiple offers (different GPU partitions,
   * interruptible/on-demand variants) can share the same machine_id — they all
   * live on the same physical box. Used by the lease manager to detect "the same
   * flaky machine keeps being re-picked" and to blacklist a known-bad host after
   * a reboot fails (see lib/gpu/lease-manager.ts escalation ladder).
   */
  machine_id?: number;
  /** Display form, e.g. "RTX 4060 Ti". */
  gpu_name: string;
  /** Number of GPUs bundled in this offer. */
  num_gpus: number;
  /** Total dollars-per-hour (GPU + host). The field we cap against. */
  dph_total: number;
  /** Deep-learning perf score. */
  dlperf: number;
  /** Perf per dollar — sort descending for best value. */
  /** Perf per dollar. NOTE: vastai field is dlperf_per_dphtotal. */
  dlperf_per_dphtotal: number;
  /** Highest CUDA version the host reports "good". RTX 5-series needs >=12.8. */
  cuda_max_good: number;
  /** Host reliability score in [0,1]. */
  reliability2?: number;
  /** Download Mbps. */
  inet_down?: number;
  /** GPU RAM in MB. */
  gpu_ram?: number;
  /** Host available disk in MB. */
  disk_space?: number;
  /** Geolocation country code. */
  geolocation?: string;
  /** Whether the offer is currently rentable. */
  rentable?: boolean;
  /** Storage $/GB/month on this host. */
  storage_sto_total?: number;
  [k: string]: unknown;
}

/** Instance lifecycle states reported by vast.ai (`cur_state`). */
export type InstanceState =
  | "requested"
  | "loading"
  | "running"
  | "paused" // paused — data preserved, storage billed
  | "stopped" // stopped — data preserved, not running (vast.ai uses both paused and stopped)
  | "exiting"
  | "error";

/** A rented instance from `vastai show instances --raw`. */
export interface Instance {
  /** Instance id (distinct from offer id). */
  id: number;
  /** Current lifecycle state. */
  cur_state: InstanceState;
  /** The machine's label, if we set one. */
  label?: string;
  /** Image URI. */
  image_uuid?: string;
  /** The GPU name, e.g. "RTX 4060". */
  gpu_name?: string;
  /** Dollars per hour for this running instance. */
  dph_total?: number;
  /** Connection info populated once running. */
  ports?: Record<string, string[]> | unknown;
  /** SSH host:port string, e.g. "root@1.2.3.4:12345", when provisioned with --ssh. */
  ssh_host?: string;
  /** When the instance transitioned to running. */
  runtime?: string;
  [k: string]: unknown;
}

/** A parsed SSH endpoint. */
export interface SshTarget {
  host: string;
  port: number;
}

/** Options for searching offers. */
export interface SearchOffersOptions {
  /** GPU models to accept (display names, e.g. "RTX 4060 Ti"). */
  gpuModels?: readonly string[];
  /** Maximum dollars-per-hour total. */
  maxDph?: number;
  /** Minimum CUDA version required. */
  minCuda?: number;
  /** Require verified hosts only. Default true. */
  verified?: boolean;
  /** Min host reliability. Default 0.9. */
  minReliability?: number;
  /** Min download Mbps. */
  minInetDown?: number;
  /** Min GPU RAM in MB. */
  minGpuRam?: number;
  /** Restrict to these 2-letter country codes (e.g. ["TW","JP","KR","SG"]).
   * Uses vastai's `geolocation in [XX,YY]` query. Undefined = no filter. */
  geolocations?: readonly string[];
  /** Sort field + direction, e.g. "dlperf_per_dphtotal-". */
  orderBy?: string;
  /**
   * Physical machine ids to EXCLUDE from results (the defensive re-filter drops
   * any offer whose machine_id is in this set). Used to avoid re-picking a
   * known-bad host that was blacklisted after a failed reboot. The exclusion is
   * enforced in code (not in the vast query DSL) because vastai's query syntax
   * has no "not in" operator for machine_id.
   */
  excludeMachineIds?: number[];
  /** Max number of offers to return. */
  limit?: number;
  /** Pricing type: on-demand (default) or interruptible. vastai CLI accepts
   *  on_demand / on-demand / ondemand / bid / ask / reserved. */
  type?: "on_demand" | "interruptible";
}

/** Options for creating an instance. */
export interface CreateInstanceOptions {
  offerId: number;
  /** Docker image, e.g. "nvidia/cuda:12.4.1-runtime-ubuntu22.04". */
  image: string;
  /** Persistent disk GB (storage billed until destroy). */
  diskGb?: number;
  /** Bash run as root on every (re)start, after the entrypoint. */
  onstart?: string;
  /** Friendly label. */
  label?: string;
  /** Pricing type. Default on_demand. */
  type?: "on_demand" | "interruptible";
  /** Cap bid ($/hr) for interruptible / sanity ceiling. */
  price?: number;
  /** Environment variables to set in the instance (e.g. { GPU_SSH_PUBKEY: "..." }). */
  env?: Record<string, string>;
}

/** The lease state stored in the DB and surfaced to the canvas. */
export type LeaseState =
  | "none" // no lease row yet
  | "queued" // waiting for an affordable offer / concurrency slot
  | "provisioning" // instance created, waiting for cur_state=running
  | "ready" // running + Blender socket reachable + tunnel up
  | "recovering" // watchdog detected a stop/dead tunnel, auto-recovering
  | "releasing" // saving artifacts + destroying
  | "destroyed"; // gone; row about to be removed
