/**
 * GPU Lease Manager — the orchestration layer for the Blender workflow.
 *
 * Owns the lifecycle of vast.ai GPU instances on behalf of Blender workflow
 * instances. One singleton per host process. Responsibilities:
 *
 *   - **Auto-acquire** a GPU lease when a Blender lane opens (the user is never
 *     asked to acquire). Subject to a platform-wide concurrency limit and a
 *     $/hr cap.
 *   - **FIFO queue** waiters when no qualifying offer exists or concurrency is
 *     full; auto-grant when capacity frees up or a sub-cap offer appears.
 *   - **Liveness watchdog** per lease: detects stopped instances (data
 *     preserved) and resumes the SAME instance via startInstance (faster +
 *     cheaper than re-provisioning); detects destroyed instances and
 *     re-provisions fresh with the last-synced .blend pushed up (continue where
 *     you left off); detects dead tunnels and re-establishes them.
 *   - **Artifact sync safety**: the GPU instance is pure ephemeral scratch. The
 *     container's /workspace/blends/<id>/ is the durable source of truth.
 *     Periodic background sync-down (60s) bounds data loss; on release the
 *     .blend + renders are pulled down BEFORE destroy (destroy always runs in a
 *     finally so storage fees never accrue).
 *   - **Idle-timeout auto-release**: a lease idle longer than the timeout is
 *     released (with sync). Lane-leave and container stop/logout also release.
 *
 * The SSH tunnel is started INSIDE the OpenCode container (via the injected
 * execInContainer function) so blender-mcp can dial a fixed 127.0.0.1:9876.
 * The tunnel is the only thing that changes per lease; the MCP config is static.
 *
 * Design notes:
 *   - All async operations are serialized per-instance via an in-flight mutex
 *     map (acquire/release/watchdog can race for the same instance).
 *   - The vast client, exec function, and ssh helpers are injectable for tests.
 */

import { db, type ContainerRow } from "../db";
import { execInContainer } from "../docker";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_GPU_IMAGE,
  DEFAULT_DISK_GB,
  vast as defaultVast,
  type VastClient,
} from "./vast";
import type { LeaseState, Offer } from "./types";

/** Default max ms a lease may stay queued before giving up (10 minutes).
 *  Overridable via GPU_QUEUE_TIMEOUT_MS env in production. */
const DEFAULT_QUEUE_TIMEOUT_MS = Number(process.env.GPU_QUEUE_TIMEOUT_MS ?? 600_000);

// ── DB row type (mirrors the gpu_leases table) ──────────────────────────────

export interface LeaseRow {
  instance_id: string;
  user_id: number;
  state: LeaseState;
  vast_id: number | null;
  gpu_name: string | null;
  dph: number | null;
  ssh_host: string | null;
  ssh_port: number | null;
  /** The vast.ai SSH key id registered for this lease (cleaned up on release). */
  ssh_key_id: number | null;
  queue_position: number | null;
  queue_requested_at: number | null;
  /** ms epoch of the last queue-pump market-search attempt (success or failure). */
  queue_last_checked_at: number | null;
  /** null when the last market search succeeded (even if empty); set to the
   *  error string when the vastai CLI/auth/network threw. Distinguishes a
   *  broken search from a genuinely empty market (previously conflated by
   *  `.catch(() => [])` in the queue pump). */
  queue_search_error: string | null;
  acquired_at: number | null;
  last_activity: number;
  last_synced_at: number | null;
  /** Last error message (cleared on successful state transition). Surfaced to UI. */
  last_error: string | null;
  /**
   * 1 when the user explicitly released the GPU (the "Release GPU" button).
   * Suppresses auto-reacquire: the watchdog will NOT reProvision, and the
   * frontend lane-open effect will NOT POST acquire. Cleared only by an
   * explicit Acquire. The row is persisted in state "destroyed" while set.
   */
  manually_released: number;
  /**
   * ms epoch at which the lease entered the `releasing` state (null otherwise).
   * The watchdog reaper uses this as a poller-independent wall-clock deadline:
   * if a release hasn't reached `destroyed` within RELEASE_DEADLINE_MS, the
   * reaper force-completes it — even if the frontend GET poll is still bumping
   * `last_activity` (which it does every 5s while the lane is open, defeating
   * the old last_activity-only stranded check).
   */
  releasing_since: number | null;
}

const now = () => Date.now();

// ── Injected container-exec contract (matches docker.ts execInContainer) ────

export interface ContainerExec {
  (
    row: ContainerRow,
    command: string[],
    opts?: { user?: string },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** SCP orchestration: copies the onstart addon onto the instance before start. */
export interface InstanceFileOps {
  /** scp a local (in-container) file onto the GPU instance. */
  scpToInstance(opts: { sshHost: string; sshPort: number; localPath: string; remotePath: string }): Promise<void>;
  /** scp a remote file from the GPU instance to a local (in-container) path. */
  scpFromInstance(opts: { sshHost: string; sshPort: number; remotePath: string; localPath: string }): Promise<void>;
}

// ── Lease manager config ────────────────────────────────────────────────────

export interface LeaseManagerConfig {
  vast?: VastClient;
  exec?: ContainerExec;
  fileOps?: InstanceFileOps;
  maxConcurrent?: number;
  idleTimeoutMs?: number;
  watchdogIntervalMs?: number; // default 10s
  syncIntervalMs?: number; // default 5s
  queuePumpIntervalMs?: number; // default 20s
  /** Max ms a lease may stay queued before giving up (default 600000 = 10 min).
   *  Set via GPU_QUEUE_TIMEOUT_MS env in production. Once exceeded the lease
   *  moves to destroyed + manually_released=1 so the "Acquire GPU" button
   *  reappears with a clear timeout message (instead of retrying invisibly
   *  forever, which previously looked like a frozen UI). */
  queueTimeoutMs?: number;
  idleReaperIntervalMs?: number; // default max(idleTimeoutMs/4, 30s)
  gpuImage?: string;
  diskGb?: number;
  /** The onstart script body (read from /app/gpu/onstart.sh at runtime). */
  onstartScript?: string;
  /** Max attempts for destroyInstanceWithRetry (default 3). */
  destroyRetries?: number;
  /** Base backoff ms for destroyInstanceWithRetry: delay = base * (attempt) (default 1500). */
  destroyBackoffMs?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const APP_USER = "appuser";
const BLENDER_PORT = "9876";
const GPU_ADDON_CONTAINER_PATH = "/app/gpu/addon.py";
const GPU_ONSTART_CONTAINER_PATH = "/app/gpu/onstart.sh";
const GPU_ONSTART_BAKED_CONTAINER_PATH = "/app/gpu/onstart-baked.sh";
/** Path to the container's SSH key for GPU instances (Approach B). */
const SSH_KEY_PATH = "/workspace/.ssh/gpu_ed25519";

/**
 * Read the onstart script body from the container's baked image copy. Uses the
 * minimal baked onstart (just service launches, ~5s) when a pre-built GPU image
 * is configured, or the full onstart (apt+download+install, ~5-7min) when using
 * the bare CUDA image. The choice is driven by the image name: if it's NOT the
 * default nvidia/cuda image, we assume it's a pre-built image with everything
 * baked in.
 */
async function readOnstartScript(exec: ContainerExec, row: ContainerRow, image: string): Promise<string> {
  const isBakedImage = !image.includes("nvidia/cuda");
  const scriptPath = isBakedImage ? GPU_ONSTART_BAKED_CONTAINER_PATH : GPU_ONSTART_CONTAINER_PATH;
  const r = await exec(row, ["cat", scriptPath], { user: APP_USER });
  if (r.code !== 0) throw new Error(`could not read onstart script (${scriptPath}): ${r.stderr}`);
  return r.stdout;
}

// ── In-flight mutex per instance ────────────────────────────────────────────

const inflight = new Map<string, Promise<unknown>>();

/**
 * Instances with a release in progress. Checked by syncTick, watchdogTick's
 * checkAndRecover, and idleReaperTick BEFORE they call withLock — if set, they
 * skip the instance entirely. This is the "private priority lane" for release:
 * it never queues behind syncTick/watchdog in the withLock promise chain.
 *
 * Set by release() before writing state; cleared by the background release
 * IIFE (manual) or the release function's finally block (non-manual) when done.
 */
const releasePending = new Set<string>();

function withLock<T>(instanceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = inflight.get(instanceId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  inflight.set(instanceId, next);
  next.finally(() => {
    if (inflight.get(instanceId) === next) inflight.delete(instanceId);
  });
  return next;
}

// ── DB helpers ──────────────────────────────────────────────────────────────

function getLease(instanceId: string): LeaseRow | null {
  return (
    (db()
      .prepare("SELECT * FROM gpu_leases WHERE instance_id = ?")
      .get(instanceId) as LeaseRow | undefined) ?? null
  );
}

function upsertLease(row: LeaseRow): void {
  db()
    .prepare(
      `INSERT INTO gpu_leases
         (instance_id, user_id, state, vast_id, gpu_name, dph, ssh_host, ssh_port, ssh_key_id,
          queue_position, queue_requested_at, queue_last_checked_at, queue_search_error,
          acquired_at, last_activity, last_synced_at, last_error,
          manually_released, releasing_since)
       VALUES (@instance_id, @user_id, @state, @vast_id, @gpu_name, @dph, @ssh_host, @ssh_port, @ssh_key_id,
          @queue_position, @queue_requested_at, @queue_last_checked_at, @queue_search_error,
          @acquired_at, @last_activity, @last_synced_at, @last_error,
          @manually_released, @releasing_since)
       ON CONFLICT(instance_id) DO UPDATE SET
         state=excluded.state, vast_id=excluded.vast_id, gpu_name=excluded.gpu_name,
         dph=excluded.dph, ssh_host=excluded.ssh_host, ssh_port=excluded.ssh_port,
         ssh_key_id=excluded.ssh_key_id,
         queue_position=excluded.queue_position, acquired_at=excluded.acquired_at,
         queue_last_checked_at=excluded.queue_last_checked_at,
         queue_search_error=excluded.queue_search_error,
         last_activity=excluded.last_activity, last_synced_at=excluded.last_synced_at,
         last_error=excluded.last_error,
         releasing_since=excluded.releasing_since`,
    )
    .run(row);
}

/**
 * Set/clear manually_released for a lease. The flag is intentionally NOT part of
 * upsertLease's ON CONFLICT update set, so ordinary state transitions can't
 * clobber it — it moves only through this explicit setter (release sets it,
 * acquire clears it).
 */
function setManuallyReleased(instanceId: string, value: 0 | 1): void {
  db()
    .prepare("UPDATE gpu_leases SET manually_released = ? WHERE instance_id = ?")
    .run(value, instanceId);
}

function deleteLease(instanceId: string): void {
  db().prepare("DELETE FROM gpu_leases WHERE instance_id = ?").run(instanceId);
}

function countActiveLeases(): number {
  // Active = provisioning, ready, or recovering (NOT queued — those don't hold a GPU).
  const r = db()
    .prepare(
      "SELECT COUNT(*) AS n FROM gpu_leases WHERE state IN ('provisioning','ready','recovering')",
    )
    .get() as { n: number };
  return r.n;
}

/**
 * Atomically claim a concurrency slot for `instanceId`. Returns true if a slot
 * was reserved (the instance should provision now), false if at capacity.
 *
 * This closes the TOCTOU window that existed when acquireImpl/queuePumpTick
 * read countActiveLeases() and then inserted/promoted in two separate
 * statements — two concurrent lanes could both pass the check and both
 * provision, exceeding maxConcurrent. Here the capacity check and the
 * provisioning-row write run in a single transaction so only one writer can
 * observe a given count and claim a slot. The row is written with
 * state='provisioning' so it immediately counts toward the active total.
 */
function claimConcurrencySlot(
  lease: LeaseRow,
  maxConcurrent: number,
): boolean {
  const txn = db().transaction(() => {
    const active = countActiveLeases();
    if (active >= maxConcurrent) return false;
    upsertLease({ ...lease, state: "provisioning", manually_released: 0 });
    return true;
  });
  return txn();
}

function queuedLeases(): LeaseRow[] {
  return db()
    .prepare("SELECT * FROM gpu_leases WHERE state = 'queued' ORDER BY queue_requested_at ASC")
    .all() as LeaseRow[];
}

// ── Lease manager ───────────────────────────────────────────────────────────

export interface LeaseManager {
  /**
   * Auto-acquire a GPU lease for a Blender workflow instance. Called on lane
   * open. Returns the current lease state (which may be 'queued' if no capacity
   * or sub-cap offer exists). Idempotent: a no-op if a lease already exists.
   */
  acquire(opts: { instanceId: string; userId: number; container: ContainerRow; resume: boolean }): Promise<LeaseRow>;

  /** Release a lease: sync artifacts down, kill tunnel, destroy instance. */
  release(instanceId: string, reason?: string): Promise<void>;

  /** Bump last_activity (called by the canvas poll + every render). */
  touch(instanceId: string): void;

  /** Get the current lease row for an instance (or null). */
  get(instanceId: string): LeaseRow | null;

  /**
   * Force an immediate queue-pump attempt for ONE queued lease (the "Retry
   * now" button), bypassing the 20s pump cadence. If a sub-cap offer is
   * available the lease is provisioned; otherwise it stays queued with its
   * diagnostic fields refreshed. No-op (resolves cleanly) when the lease is
   * absent or not in the queued state.
   */
  retryQueued(instanceId: string): Promise<void>;

  /** Start the background loops (watchdog, sync, queue pump, idle reaper). */
  start(): void;
  /** Stop the background loops (for graceful shutdown / tests). */
  stop(): void;

  /**
   * Push selected brand assets to the GPU instance for a Blender lane. Reads
   * brand_selection.json from the workspace, resolves each selected asset to
   * its file path, and SCPs it to /root/assets/ on the GPU. Skips files that
   * already exist with the same size (no re-transfer). Best-effort: returns
   * silently if no lease is active or the push fails.
   */
  pushBrandAssets(instanceId: string): Promise<void>;

  /**
   * Restart Blender in-place on the GPU instance (agent-callable). Used when
   * the Blender process has crashed (segfault) but the vast.ai instance is
   * still running. SSHes in, kills stale Blender, relaunches with the saved
   * scene.blend, and polls until the add-on socket responds. Returns {ok:true}
   * on success, {ok:false, error} on failure.
   */
  restartBlender(instanceId: string): Promise<{ ok: boolean; error?: string }>;
}

export function createLeaseManager(config: LeaseManagerConfig = {}): LeaseManager {
  const vast = config.vast ?? defaultVast;
  const maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const watchdogIntervalMs = config.watchdogIntervalMs ?? 10_000;
  const syncIntervalMs = config.syncIntervalMs ?? 5_000;
  const queuePumpIntervalMs = config.queuePumpIntervalMs ?? 20_000;
  const queueTimeoutMs = config.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  const idleReaperIntervalMs = config.idleReaperIntervalMs ?? Math.max(idleTimeoutMs / 4, 30_000);
  const gpuImage = config.gpuImage ?? DEFAULT_GPU_IMAGE;
  const diskGb = config.diskGb ?? DEFAULT_DISK_GB;
  const destroyRetries = config.destroyRetries ?? 3;
  const destroyBackoffMs = config.destroyBackoffMs ?? 1500;

  // exec/fileOps: use the injected values if provided (tests), otherwise the
  // real docker.ts implementations. fileOps is only used by tests; production
  // SCP is done via execInContainer directly in provisionInstance/syncDown
  // (where the container row is available).
  const exec: ContainerExec = config.exec ?? execInContainer;
  const fileOps: InstanceFileOps = config.fileOps ?? {
    async scpToInstance() { /* no-op: production uses execInContainer directly */ },
    async scpFromInstance() { /* no-op: production uses execInContainer directly */ },
  };

  const timers: ReturnType<typeof setInterval>[] = [];

  // ── Provisioning ──────────────────────────────────────────────────────────

  /**
   * Rent an instance, wait for running, sync the .blend up (if resuming), and
   * start the in-container SSH tunnel. Sets state to 'ready' on success.
   * Throws on failure (caller decides whether to re-queue or give up).
   *
   * Approach B: the container generates its own SSH keypair, the host registers
   * the pubkey on vast.ai, the instance auto-injects it, and all SSH/SCP runs
   * inside the container using that key. VAST_API_KEY never enters the container.
   */
  async function provisionInstance(lease: LeaseRow, container: ContainerRow, resume: boolean): Promise<void> {
    // ── 1. Ensure the container has an SSH keypair ──────────────────────────
    // The key persists in the workspace volume so it's reused across container
    // restarts. Each container gets its own key — a compromised key only works
    // for instances created under this account with that pubkey registered.
    const SSH_KEY_PATH = "/workspace/.ssh/gpu_ed25519";
    const keyCheck = await exec(container, ["bash", "-lc", `test -f ${SSH_KEY_PATH} && echo exists`], { user: APP_USER });
    if (!keyCheck.stdout.includes("exists")) {
      const gen = await exec(
        container,
        ["bash", "-lc", `mkdir -p /workspace/.ssh && ssh-keygen -t ed25519 -f ${SSH_KEY_PATH} -N "" -q && echo generated`],
        { user: APP_USER },
      );
      if (!gen.stdout.includes("generated")) throw new Error("failed to generate SSH keypair in container");
    }
    // Read the public key.
    const pubKeyRes = await exec(container, ["bash", "-lc", `cat ${SSH_KEY_PATH}.pub`], { user: APP_USER });
    const pubKey = pubKeyRes.stdout.trim();
    if (!pubKey.startsWith("ssh-")) throw new Error(`invalid SSH public key: ${pubKey.slice(0, 40)}`);

    // ── 2. Register the pubkey on vast.ai ───────────────────────────────────
    // Check if already registered (reuse across leases) to avoid duplicates.
    let sshKeyId: number | null = null;
    const existingKeys = await vast.listSshKeys().catch(() => []);
    const existing = existingKeys.find((k) => k.public_key === pubKey);
    if (existing) {
      sshKeyId = existing.id;
    } else {
      const created = await vast.createSshKey(pubKey);
      sshKeyId = created.id;
    }
    const cur0 = getLease(lease.instance_id) ?? lease;
    upsertLease({ ...cur0, ssh_key_id: sshKeyId });

    // ── 3. Search + create the instance ─────────────────────────────────────
    // The SSH public key is passed via --env GPU_SSH_PUBKEY so the onstart
    // script can inject it directly into authorized_keys. This is more reliable
    // than vast.ai's `attach ssh` API (which often silently fails).
    const offers = await vast.searchOffers({ limit: 5 });
    if (offers.length === 0) throw new Error("no qualifying GPU offers under cap");
    const offer = offers[0];
    const onstart = await readOnstartScript(exec, container, gpuImage);

    const { id: vastId } = await vast.createInstance({
      offerId: offer.id,
      image: gpuImage,
      diskGb,
      onstart,
      label: `blender-${lease.instance_id.slice(0, 8)}`,
      env: {
        GPU_SSH_PUBKEY: pubKey,
        // Sketchfab: the blender-mcp addon reads BLENDERMCP_SKETCHFAB_API_KEY
        // from env (its 3rd-level key fallback). Renamed at pass-through so the
        // user's SKETCHFAB_API_KEY in web/.env reaches the addon's expected var
        // on the GPU instance. Env-var only — never written into scene.blend, so
        // the key can't leak via syncDown. Omitted entirely when unset (so users
        // who don't configure Sketchfab see no empty var on the instance).
        ...(process.env.SKETCHFAB_API_KEY
          ? { BLENDERMCP_SKETCHFAB_API_KEY: process.env.SKETCHFAB_API_KEY }
          : {}),
      },
    });
    const cur1 = getLease(lease.instance_id) ?? lease;
    upsertLease({ ...cur1, state: "provisioning", vast_id: vastId, gpu_name: offer.gpu_name, dph: offer.dph_total, acquired_at: now() });

    // Everything after createInstance must clean up the instance on failure.
    // Without this, a failed SCP or socket timeout orphans a billing instance.
    try {
      // ── 4. Wait for running + SSH readiness ───────────────────────────────
      await vast.waitForRunning(vastId);
      const target = await vast.sshUrl(vastId);
      if (!target) throw new Error(`instance ${vastId} has no ssh url`);
      const cur2 = getLease(lease.instance_id) ?? lease;
      upsertLease({ ...cur2, state: "provisioning", vast_id: vastId, ssh_host: target.host, ssh_port: target.port });

      // Wait for SSH to actually accept connections (not just cur_state=running).
      // The CUDA image + onstart boot takes time; the onstart script injects the
      // SSH key early, but sshd still needs to finish starting.
      await waitForSsh(container, target);

      // ── 5. SCP the addon.py onto the instance ──────────────────────────────
      // All SSH/SCP runs INSIDE the container using the container's own key.
      const scpBase = `ssh -i ${SSH_KEY_PATH} -p ${target.port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10`;
      const scpOpts = `-i ${SSH_KEY_PATH} -P ${target.port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10`;

      // SCP the addon.py onto the instance — only needed for the bare CUDA image
      // (the pre-built image already has the addon baked in). Best-effort:
      // onstart.sh has a GitHub fallback for the addon, so failure is non-fatal.
      const isBakedImage = !gpuImage.includes("nvidia/cuda");
      if (!isBakedImage) {
        await exec(container, ["bash", "-lc", `${scpBase} root@${target.host} 'mkdir -p /app/gpu'`], { user: APP_USER }).catch(() => {});
        await exec(
          container,
          ["bash", "-lc", `scp ${scpOpts} '${GPU_ADDON_CONTAINER_PATH}' 'root@${target.host}:/app/gpu/addon.py'`],
          { user: APP_USER },
        ).catch((e) => {
          console.warn(`[lease-manager] scp addon.py failed (onstart will fall back to GitHub):`, (e as Error).message);
        });
      }

      // Resume: push the saved .blend up so Blender opens at the last save.
      if (resume) {
        const blendPath = `/workspace/blends/${lease.instance_id}/scene.blend`;
        const exists = await exec(container, ["test", "-f", blendPath], { user: APP_USER });
        if (exists.code === 0) {
          await exec(
            container,
            ["bash", "-lc", `${scpBase} root@${target.host} 'mkdir -p /root/blender' && scp ${scpOpts} '${blendPath}' 'root@${target.host}:/root/blender/scene.blend'`],
            { user: APP_USER },
          ).catch(() => {}); // best-effort
        }

        // Push brand assets selected for this lane to the GPU instance.
        // The shared function handles size-checking (skips unchanged files).
        await pushBrandAssetsImpl(lease.instance_id).catch(() => {});
      }

      // ── 6. Wait for the onstart script to bring up blender-mcp ──────────────
      await waitForBlenderSocket(container, target);

      // ── 7. Start the SSH tunnel INSIDE the container ────────────────────────
      await startTunnel(container, target);

      const cur3 = getLease(lease.instance_id) ?? lease;
      upsertLease({ ...cur3, state: "ready", last_activity: now(), last_error: null });

      // On a resume, the pushed scene.blend was saved by a prior session and
      // carries its serialized blendermcp_use_polyhaven / blendermcp_use_sketchfab
      // values. Blends saved before the startup-enable fix carry False, so the
      // agent's polyhaven/sketchfab tools come back "disabled" until re-enabled.
      // Re-assert both props on the resumed scene now that the socket is up,
      // and re-save so the corrected values persist. Best-effort: wrapped to
      // never block provisioning on a re-enable failure. (The Sketchfab API key
      // is NOT set here — it's delivered as an env var at create-time, so it
      // never lands in scene.blend.)
      if (resume) {
        await exec(
          container,
          [
            "bash",
            "-lc",
            `echo '{"type":"execute_code","params":{"code":"import bpy; bpy.context.scene.blendermcp_use_polyhaven = True; bpy.context.scene.blendermcp_use_sketchfab = True; bpy.ops.wm.save_as_mainfile(filepath=\\\\\\"/root/blender/scene.blend\\\\\\")"}}' | timeout 10 nc -q1 127.0.0.1 ${BLENDER_PORT} 2>/dev/null || true`,
          ],
          { user: APP_USER },
        ).catch(() => {});
      }
    } catch (e) {
      // Provisioning failed after the instance was created — destroy it so it
      // doesn't keep billing as an orphan. The caller will move the lease to
      // "queued" for retry.
      console.error(`[lease-manager] provision failed for ${lease.instance_id}, destroying instance ${vastId}:`, (e as Error).message);
      await vast.destroyInstance(vastId).catch((err) =>
        console.error(`[lease-manager] cleanup-destroy failed for orphan ${vastId}:`, (err as Error).message),
      );
      throw e;
    }
  }

  /** Wait until SSH on the instance accepts connections (sshd ready). */
  async function waitForSsh(
    container: ContainerRow,
    target: { host: string; port: number },
    timeoutMs: number = Number(process.env.GPU_SSH_TIMEOUT_MS ?? 300_000),
  ): Promise<void> {
    const pollMs = Number(process.env.GPU_POLL_INTERVAL_MS ?? 5000);
    const deadline = Date.now() + timeoutMs;
    const SSH_KEY_PATH = "/workspace/.ssh/gpu_ed25519";
    while (Date.now() < deadline) {
      const probe = await exec(
        container,
        ["bash", "-lc", `timeout 10 ssh -i ${SSH_KEY_PATH} -p ${target.port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 root@${target.host} 'echo ssh_ready' 2>/dev/null`],
        { user: APP_USER },
      ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      if (probe.stdout.includes("ssh_ready")) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`SSH did not become ready on ${target.host}:${target.port} within ${timeoutMs}ms`);
  }

  /** Wait until the onstart sentinel exists on the instance. */
  async function waitForBlenderSocket(
    container: ContainerRow,
    target: { host: string; port: number },
    timeoutMs: number = Number(process.env.GPU_SOCKET_TIMEOUT_MS ?? 5 * 60_000),
  ): Promise<void> {
    const pollMs = Number(process.env.GPU_POLL_INTERVAL_MS ?? 5000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Probe the readiness sentinel via SSH from inside the container, using
      // the container's own key.
      const probe = await exec(
        container,
        [
          "bash",
          "-lc",
          `timeout 10 ssh -i ${SSH_KEY_PATH} -p ${target.port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 root@${target.host} 'test -f /root/.blender-mcp-ready' 2>/dev/null`,
        ],
      ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      if (probe.code === 0) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`blender-mcp socket did not come up on ${target.host}:${target.port}`);
  }

  /** Start the in-container SSH tunnel: local 9876 -> instance 9876. */
  async function startTunnel(container: ContainerRow, target: { host: string; port: number }): Promise<void> {
    // autossh supervises the SSH tunnel: auto-restarts on death and uses SSH
    // keepalives for reliable failure detection. -M 0 = no legacy monitor port
    // (relies on ServerAliveInterval). -f = background. AUTOSSH_GATETIME=0
    // skips the 30s pre-start delay so the tunnel comes up immediately.
    // ExitOnForwardFailure=yes makes startup failures visible (the old
    // `2>/dev/null || true` swallowed them, so the watchdog saw "dead" every
    // 10s with no clue why). stderr is appended to a logfile for diagnosis.
    const cmd = [
      "bash",
      "-lc",
      `AUTOSSH_GATETIME=0 AUTOSSH_LOGFILE=/tmp/autossh-${BLENDER_PORT}.log autossh -M 0 -f -N -L ${BLENDER_PORT}:127.0.0.1:${BLENDER_PORT} -i ${SSH_KEY_PATH} -p ${target.port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o ConnectTimeout=10 root@${target.host} 2>>/tmp/autossh-${BLENDER_PORT}.log || echo "[startTunnel] autossh failed to start: exit=$?"`,
    ];
    await exec(container, cmd, { user: APP_USER });
  }

  /** Kill the in-container SSH tunnel (best-effort). */
  async function stopTunnel(container: ContainerRow): Promise<void> {
    // Kill autossh first (so it stops respawning ssh), then kill any orphaned
    // ssh children. autossh propagates SIGTERM to its ssh child, but orphans
    // from previously-killed autossh processes can survive and hold the port.
    //
    // CRITICAL: the ssh child's cmdline has "-N -L 9876:" (autossh passes -N
    // and -L through WITHOUT the -f flag, which is autossh's own). The old
    // pattern "ssh -NfL 9876:" didn't match, leaving orphans alive to hold
    // port 9876 — causing new autossh processes to fail with
    // ExitOnForwardFailure=yes (error 255) and accumulate.
    await exec(
      container,
      ["bash", "-lc", `pkill -f "autossh.*${BLENDER_PORT}:" 2>/dev/null; sleep 0.2; pkill -f "ssh.*-L.*${BLENDER_PORT}:" 2>/dev/null; true`],
      { user: APP_USER },
    ).catch(() => {});
  }

  /**
   * Restart Blender in-place on the GPU instance when the process has crashed
   * (segfault) but the instance itself is still running and SSH-reachable.
   *
   * This is the lightweight recovery path between "tunnel dead → restart autossh"
   * and "instance stopped → startInstance/reProvision": it SSHes into the running
   * instance, kills any stale Blender process, and relaunches Blender with the
   * saved scene.blend (preserving the agent's last-saved work). No vast.ai
   * destroy, no re-provision, no .blend re-push. Cheapest possible recovery.
   *
   * Returns true if the Blender add-on socket came back up within the timeout.
   */
  async function restartBlender(
    container: ContainerRow,
    target: { host: string; port: number },
    timeoutMs: number = Number(process.env.GPU_RESTART_TIMEOUT_MS ?? 2 * 60_000),
  ): Promise<boolean> {
    const pollMs = Number(process.env.GPU_POLL_INTERVAL_MS ?? 5000);
    const sshOpts = `ssh -i ${SSH_KEY_PATH} -p ${target.port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10`;
    const ssh = (cmd: string) =>
      exec(container, ["bash", "-lc", `${sshOpts} root@${target.host} '${cmd.replace(/'/g, "'\\''")}' 2>&1`], {
        user: APP_USER,
      }).catch(() => ({ code: 1, stdout: "", stderr: "" }));

    // 1. Clear the stale readiness sentinel so waitForBlenderSocket won't see a
    //    false-positive from the previous Blender session.
    await ssh("rm -f /root/.blender-mcp-ready");

    // 2. Kill any stale Blender process. Wait for it to actually die.
    await ssh("pkill -f blender 2>/dev/null; sleep 2");

    // 3. Relaunch Blender. Load the saved scene.blend if it exists so the
    //    agent's last-saved work is preserved (start_blender_mcp.py will
    //    re-enable the addon and restart the socket server on the loaded scene).
    const relaunchCmd = [
      "if [ -f /root/blender/scene.blend ]; then",
      "  BLENDER_FILE=/root/blender/scene.blend",
      "else",
      "  BLENDER_FILE=",
      "fi",
      "DISPLAY=:99 BLENDER_PORT=9876 nohup /opt/blender/blender $BLENDER_FILE --python /root/start_blender_mcp.py >>/root/onstart.log 2>&1 &",
    ].join("; ");
    await ssh(relaunchCmd);

    // 4. Poll the add-on socket directly on the GPU instance (not the tunnel —
    //    the tunnel is a separate concern). The socket accepting a real
    //    get_scene_info request means Blender + addon are alive, not just that
    //    a port is open.
    const deadline = Date.now() + timeoutMs;
    const probeCmd =
      'python3 -c "' +
      "import socket, json; " +
      "s = socket.socket(); s.settimeout(3); " +
      "s.connect(('127.0.0.1', 9876)); " +
      "s.sendall(json.dumps({'type':'get_scene_info','params':{}}).encode() + b'\\n'); " +
      "d = s.recv(4096); print('ok' if d else 'empty'); s.close()" +
      '" 2>/dev/null';
    while (Date.now() < deadline) {
      const probe = await ssh(probeCmd);
      if (probe.stdout.includes("ok")) {
        // 5. Restore the sentinel so waitForBlenderSocket stays consistent.
        await ssh("touch /root/.blender-mcp-ready");
        // 6. Restart the tunnel to clear any stale SSH forward state.
        await stopTunnel(container);
        await startTunnel(container, target);
        return true;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  /**
   * Write a phase update to the workflow's state.json. Used by the lease
   * manager to couple lease lifecycle transitions (e.g. GPU lost → recovering)
   * into the workflow state the canvas polls, so the viewport doesn't stay
   * stuck on a stale phase from a dead render process.
   */
  async function writeWorkflowPhase(
    lease: LeaseRow,
    container: ContainerRow,
    phase: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    const folder = `/workspace/blends/${lease.instance_id}`;
    const patch = JSON.stringify({ phase, lastUpdated: new Date().toISOString(), ...extra });
    const cmd = `python3 - <<'__STATE_EOF__'
import json, os
path = "${folder}/state.json"
state = {}
try:
    with open(path) as f: state = json.load(f)
except Exception: pass
state.update(${patch})
with open(path, "w") as f: json.dump(state, f, indent=2)
__STATE_EOF__`;
    await exec(container, ["bash", "-lc", cmd], { user: APP_USER }).catch(() => {});
  }

  /**
   * Get the byte size of a remote file on the GPU instance via SSH stat.
   * Returns null if the file doesn't exist or the command fails.
   */
  async function remoteFileSize(
    container: ContainerRow,
    sshHost: string,
    sshPort: number,
    remotePath: string,
  ): Promise<number | null> {
    const sshOpts = `ssh -i ${SSH_KEY_PATH} -p ${sshPort} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5`;
    const r = await exec(
      container,
      ["bash", "-lc", `${sshOpts} root@${sshHost} 'stat -c %s "${remotePath}" 2>/dev/null' 2>/dev/null`],
      { user: APP_USER },
    ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    const size = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(size) && size >= 0 ? size : null;
  }

  /** Get the byte size of a local file in the container. Returns null if missing. */
  async function localFileSize(container: ContainerRow, localPath: string): Promise<number | null> {
    const r = await exec(container, ["bash", "-lc", `stat -c %s "${localPath}" 2>/dev/null || true`], {
      user: APP_USER,
    }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    const size = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(size) && size >= 0 ? size : null;
  }

  /** Sync the .blend + renders from the instance down to the workspace. */
  async function syncDown(lease: LeaseRow, container: ContainerRow): Promise<void> {
    if (!lease.ssh_host || !lease.ssh_port) return;
    const scpOpts = `-i ${SSH_KEY_PATH} -P ${lease.ssh_port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10`;
    const folder = `/workspace/blends/${lease.instance_id}`;
    await exec(container, ["mkdir", "-p", `${folder}/exports`], { user: APP_USER }).catch(() => {});
    try {
      // scene.blend: compare sizes before transferring to avoid unnecessary
      // egress charges (syncDown runs every 60s; .blend can be 500KB+).
      const remoteBlendSize = await remoteFileSize(container, lease.ssh_host, lease.ssh_port, "/root/blender/scene.blend");
      const localBlendSize = await localFileSize(container, `${folder}/scene.blend`);
      if (remoteBlendSize !== null && remoteBlendSize !== localBlendSize) {
        const r1 = await exec(
          container,
          ["bash", "-lc", `scp ${scpOpts} 'root@${lease.ssh_host}:/root/blender/scene.blend' '${folder}/scene.blend'`],
          { user: APP_USER },
        );
        if (r1.code !== 0) {
          console.warn(`[lease-manager] syncDown: scp scene.blend failed for ${lease.instance_id}`);
        }
      }

      // Renders: list remote files + sizes, then only transfer new/changed ones.
      // This avoids re-transferring unchanged PNGs every 60s.
      const sshOpts = `ssh -i ${SSH_KEY_PATH} -p ${lease.ssh_port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5`;
      const listRes = await exec(
        container,
        ["bash", "-lc", `${sshOpts} root@${lease.ssh_host} 'ls -la /root/blender/renders/ 2>/dev/null' 2>/dev/null`],
        { user: APP_USER },
      ).catch(() => ({ code: 0, stdout: "", stderr: "" }));

      // Parse `ls -la` output: each line is "perms links owner group SIZE DATE NAME"
      const remoteFiles: Array<{ name: string; size: number }> = [];
      for (const line of listRes.stdout.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 9 && !parts[0].startsWith("d") && !parts[0].startsWith("total")) {
          const size = parseInt(parts[4], 10);
          const name = parts.slice(8).join(" ");
          if (name && Number.isFinite(size)) remoteFiles.push({ name, size });
        }
      }

      for (const { name, size: remoteSize } of remoteFiles) {
        const localSize = await localFileSize(container, `${folder}/exports/${name}`);
        if (remoteSize !== localSize) {
          await exec(
            container,
            ["bash", "-lc", `scp ${scpOpts} 'root@${lease.ssh_host}:/root/blender/renders/${name}' '${folder}/exports/${name}'`],
            { user: APP_USER },
          ).catch(() => {}); // best-effort
        }
      }

      // Bump only last_synced_at. Do NOT use upsertLease here: the `lease` arg is
      // a snapshot taken before this call, and upsertLease's ON CONFLICT clause
      // would write the snapshot's (possibly stale) state/vast_id/etc. back over
      // the live row — e.g. clobbering a release's "destroyed" terminal state
      // when the background release sync runs against a snapshot with
      // state="ready". A targeted UPDATE touches only the timestamp.
      db()
        .prepare("UPDATE gpu_leases SET last_synced_at = ? WHERE instance_id = ?")
        .run(now(), lease.instance_id);
    } catch (e) {
      // Sync failure is logged but non-fatal — the periodic sync will retry.
      console.error(`[lease-manager] syncDown failed for ${lease.instance_id}:`, (e as Error).message);
    }
  }

  // ── Acquire / release ─────────────────────────────────────────────────────

  async function acquireImpl(opts: {
    instanceId: string;
    userId: number;
    container: ContainerRow;
    resume: boolean;
  }): Promise<LeaseRow> {
    const existing = getLease(opts.instanceId);
    if (existing) {
      // A lease already exists for this lane. Three cases:
      //  - Active (queued/provisioning/ready/recovering/releasing): idempotent
      //    no-op — return the current row.
      //  - Destroyed + manually_released=1: the user explicitly released the GPU
      //    and is now clicking "Acquire GPU". Clear the flag and reprovision.
      //  - Destroyed + manually_released=0: leftover terminal row (rare) — also
      //    reprovision.
      const isTerminal = existing.state === "destroyed" || existing.manually_released === 1;
      if (!isTerminal) return existing;
      // Explicit re-acquire: clear the flag, then fall through to provision. We
      // reuse the existing row (preserving user_id etc.) but reset instance
      // fields so provisionInstance starts clean. resume:true pushes the saved
      // .blend back up so the scene is restored.
      setManuallyReleased(opts.instanceId, 0);
      const reset: LeaseRow = {
        ...existing,
        state: "provisioning",
        vast_id: null,
        gpu_name: null,
        dph: null,
        ssh_host: null,
        ssh_port: null,
        ssh_key_id: null,
        queue_position: null,
        queue_requested_at: null,
        acquired_at: now(),
        last_activity: now(),
        last_synced_at: null,
        last_error: null,
        manually_released: 0,
        releasing_since: null,
      };
      // Atomically reserve a slot (or queue if at capacity) before provisioning.
      if (!claimConcurrencySlot(reset, maxConcurrent)) {
        const queued: LeaseRow = { ...reset, state: "queued", queue_position: queuedLeases().length, queue_requested_at: now() };
        upsertLease(queued);
        return queued;
      }
      try {
        await provisionInstance(getLease(opts.instanceId) ?? reset, opts.container, true);
      } catch (e) {
        const msg = (e as Error).message;
        console.error(`[lease-manager] re-acquire provision failed for ${opts.instanceId}:`, msg);
        const cur = getLease(opts.instanceId) ?? reset;
        upsertLease({
          ...cur,
          state: "queued",
          vast_id: null,
          queue_requested_at: now(),
          queue_position: queuedLeases().length,
          last_error: msg,
        });
      }
      return getLease(opts.instanceId)!;
    }

    // ── Fresh acquire (no existing row) ──────────────────────────────────────
    // Build the base row once. The capacity check + provisioning-row write are
    // done atomically by claimConcurrencySlot to close the TOCTOU window where
    // two concurrent lanes could both pass the count and both provision.
    const base: LeaseRow = {
      instance_id: opts.instanceId,
      user_id: opts.userId,
      state: "provisioning",
      vast_id: null,
      gpu_name: null,
      dph: null,
      ssh_host: null,
      ssh_port: null,
      ssh_key_id: null,
      queue_position: null,
      queue_requested_at: null,
      queue_last_checked_at: null,
      queue_search_error: null,
      acquired_at: now(),
      last_activity: now(),
      last_synced_at: null,
      last_error: null,
      manually_released: 0,
      releasing_since: null,
    };

    if (!claimConcurrencySlot(base, maxConcurrent)) {
      const queued: LeaseRow = {
        ...base,
        state: "queued",
        queue_position: queuedLeases().length,
        queue_requested_at: now(),
      };
      upsertLease(queued);
      return queued;
    }

    try {
      await provisionInstance(getLease(opts.instanceId) ?? base, opts.container, opts.resume);
    } catch (e) {
      // Provisioning failed — store the error so the UI can show WHY, then move
      // to queued so the queue pump can retry when conditions improve.
      const msg = (e as Error).message;
      console.error(`[lease-manager] provision failed for ${opts.instanceId}:`, msg);
      const cur = getLease(opts.instanceId) ?? base;
      upsertLease({
        ...cur,
        state: "queued",
        vast_id: null,
        queue_requested_at: now(),
        queue_position: queuedLeases().length,
        last_error: msg,
      });
    }
    return getLease(opts.instanceId)!;
  }

  // Tracked in-flight vast.ai destroys, so background releases can be observed
  // and a second release for the same instance can await the first instead of
  // racing. Keyed by vast_id.
  const pendingDestroys = new Map<number, Promise<void>>();

  /**
   * Destroy a vast.ai instance with a bounded retry. Returns true on success.
   * Network blips and transient vast.ai errors are common; one swallow-on-error
   * left orphaned billing instances (the old reProvision path). We retry a
   * couple of times with a short backoff before giving up.
   */
  async function destroyInstanceWithRetry(vastId: number): Promise<boolean> {
    const existing = pendingDestroys.get(vastId);
    if (existing) {
      await existing.catch(() => {});
      return true;
    }
    const attempt = (async () => {
      for (let i = 0; i < destroyRetries; i++) {
        try {
          await vast.destroyInstance(vastId);
          return;
        } catch (e) {
          console.warn(`[lease-manager] destroy attempt ${i + 1} failed for ${vastId}:`, (e as Error).message);
          if (i < destroyRetries - 1) await new Promise((r) => setTimeout(r, destroyBackoffMs * (i + 1)));
        }
      }
      throw new Error(`destroy failed after retries for ${vastId}`);
    })();
    pendingDestroys.set(vastId, attempt);
    try {
      await attempt;
      return true;
    } catch (e) {
      console.error(`[lease-manager] ${vastId}:`, (e as Error).message);
      return false;
    } finally {
      pendingDestroys.delete(vastId);
    }
  }

  /**
   * Save the .blend on the GPU instance, sync artifacts down, and stop the
   * tunnel. Shared by all release reasons. Best-effort per step (sync failure
   * must NOT block destroy); returns nothing.
   */
  async function saveSyncAndStopTunnel(lease: LeaseRow, container: ContainerRow | undefined): Promise<void> {
    // 1. Save the .blend on the instance.
    if (lease.ssh_host && lease.ssh_port && lease.vast_id) {
      // Ask Blender to save via the socket through the tunnel.
      if (container) {
        await exec(
          container,
          [
            "bash",
            "-lc",
            `echo '{"type":"execute_code","params":{"code":"import bpy; bpy.ops.wm.save_as_mainfile(filepath=\\"/root/blender/scene.blend\\")"}}' | timeout 10 nc -q1 127.0.0.1 ${BLENDER_PORT} 2>/dev/null || true`,
          ],
          { user: APP_USER },
        ).catch(() => {});
      }
    }
    // 2. Sync artifacts down (best-effort; destroy runs regardless).
    if (container) await syncDown(lease, container).catch((e) => {
      console.error(`[lease-manager] syncDown failed for ${lease.instance_id}:`, (e as Error).message);
    });
    // 3. Kill the tunnel.
    if (container) await stopTunnel(container).catch(() => {});
  }

  async function releaseImpl(instanceId: string, reason: string = "manual"): Promise<void> {
    const lease = getLease(instanceId);
    if (!lease) return;
    if (lease.state === "destroyed") return;
    console.log(`[lease-manager] releasing ${instanceId} (reason: ${reason})`);

    const container = db()
      .prepare("SELECT * FROM containers WHERE user_id = ?")
      .get(lease.user_id) as ContainerRow | undefined;

    if (reason === "manual") {
      // ── Manual release (the "Release GPU" button) ─────────────────────────
      // State machine: ready → releasing → destroyed.
      //
      // The FIRST synchronous write flips the row to `releasing` (not directly
      // to `destroyed`) so every concurrent reader — the UI's 5s GET poll, and
      // the AI's per-message lease prefill — observes a durable "release in
      // progress" signal the instant the per-instance lock is acquired. Without
      // this, the row briefly still reads `ready` during the release and the AI
      // can truthfully-but-misleadingly report "blender tools are reachable" /
      // the UI can re-show "Release GPU" after a lane remount.
      //
      // `releasing` is held until the background destroy completes, then flipped
      // to the terminal `destroyed` state. The DELETE route handler awaits
      // release(), so only the synchronous prologue above runs before the
      // request returns — the slow save/sync/stop/destroy (which can take
      // minutes with real SSH latency) runs on a detached background promise.
      // Data safety is preserved: the background sync runs from a SNAPSHOT of
      // the pre-release lease (ssh fields intact) so it can still reach the
      // instance, and the 5s periodic syncTick bounds .blend staleness to ~5s
      // if the process is killed before the background sync completes.
      //
      // Residual window: between the user's click and the lock being acquired
      // (a prior watchdog/recover tick may briefly hold it), the row is still
      // in its pre-release state. This sub-second window is unavoidable without
      // writing before the lock (which would race other per-instance ops); the
      // client's sessionStorage pending-release flag covers it for the UI.
      const vastId = lease.vast_id;
      const sshKeyId = lease.ssh_key_id;
      // Transitional state SYNCHRONOUSLY: releasing + flag. ssh/vast fields stay
      // intact so the background sync can still reach the instance; they are
      // nulled only when the row reaches `destroyed`. releasing_since stamps the
      // wall-clock entry into `releasing` so the reaper can force-complete a
      // release that hasn't reached `destroyed` within RELEASE_DEADLINE_MS
      // regardless of poller activity.
      upsertLease({ ...lease, state: "releasing", manually_released: 1, releasing_since: now() });
      setManuallyReleased(instanceId, 1);
      // Background: save → sync → stop tunnel → destroy → delete ssh key →
      // terminal `destroyed` + null instance fields. Tracked so a second release
      // awaits it instead of racing; the watchdog reaper also finalizes stranded
      // `releasing` rows whose process was killed mid-destroy.
      const snapshot = { ...lease };
      void (async () => {
        try {
          if (container) {
            await saveSyncAndStopTunnel(snapshot, container).catch((e) =>
              console.error(`[lease-manager] background sync/stop failed for ${instanceId}:`, (e as Error).message),
            );
            await writeWorkflowPhase(snapshot, container, "idle", { active: null }).catch(() => {});
          }
          if (vastId) {
            await destroyInstanceWithRetry(vastId).catch(() => {});
          }
          if (sshKeyId) {
            await vast.deleteSshKey(sshKeyId).catch(() => {});
          }
          // Flip to the terminal `destroyed` state and null the instance fields.
          // Re-read in case a re-acquire reset the row in the meantime; only
          // finalize if we still own it (state=releasing + manually_released=1).
          // This guards against clobbering a freshly re-acquired lease — the same
          // snapshot-stomping hazard syncDown guards against (see the comment
          // there).
          const cur = getLease(instanceId);
          if (cur && cur.manually_released === 1 && cur.state === "releasing") {
            upsertLease({
              ...cur,
              state: "destroyed",
              ssh_host: null,
              ssh_port: null,
              vast_id: null,
              ssh_key_id: null,
              releasing_since: null,
            });
          }
        } finally {
          // Clear the priority-lane flag so the reaper can force-complete this
          // row if the background IIFE crashed or was killed mid-destroy.
          releasePending.delete(instanceId);
        }
      })().catch((e) => console.error(`[lease-manager] background release failed for ${instanceId}:`, (e as Error).message));
      return;
    }

    // ── Non-manual release (idle-timeout, lane-deleted, …) ──────────────────
    // Same behavior as before: sync → destroy (in finally) → deleteLease. No row
    // remains, so the next lane open auto-acquires (state="none"). This keeps
    // crash/idle recovery "just works" — only an explicit user release suppresses
    // auto-reacquire.
    upsertLease({ ...lease, state: "releasing", releasing_since: now() });
    try {
      await saveSyncAndStopTunnel(lease, container);
    } finally {
      // ALWAYS destroy (storage fees accrue until destroy). In finally so it
      // runs even if sync/save failed.
      if (lease.vast_id) {
        await destroyInstanceWithRetry(lease.vast_id);
      }
      // Clean up the SSH key from vast.ai (best-effort — the key is harmless
      // if left behind since no matching instance exists, but tidying avoids
      // accumulating stale keys across many leases).
      if (lease.ssh_key_id) {
        await vast.deleteSshKey(lease.ssh_key_id).catch(() => {});
      }
      deleteLease(instanceId);
    }
  }

  // ── Watchdog (liveness + recovery) ────────────────────────────────────────

  /**
   * Age beyond which a 'releasing' row is considered stranded (its releaseImpl
   * was killed — e.g. the request hit maxDuration=300s mid-destroy — before it
   * could call deleteLease / reach the destroyed terminal state). The watchdog
   * reaps such rows so the UI never gets stuck on "Releasing…" forever. Now that
   * touch() no longer refreshes releasing/destroyed rows, the poller can't
   * defeat this check — the row's last_activity goes stale ~STALE_RELEASING_MS
   * after release begins, independent of the destroy chain's progress. The
   * faster STALE_RELEASING_MS path fires when the chain is simply slow; the
   * RELEASE_DEADLINE_MS (below) is the hard backstop.
   */
  const STALE_RELEASING_MS = 60_000;

  /**
   * Hard wall-clock deadline on the 'releasing' state, keyed on releasing_since.
   * Independent of poller activity (the frontend GET poll bumps last_activity
   * every 5s, which used to mask a stuck release indefinitely). A release older
   * than this is force-completed no matter what — so a hung scp/vastai await
   * can't bill the user forever. Intentionally longer than STALE_RELEASING_MS so
   * the faster last_activity path is the common case; this is the guarantee.
   */
  const RELEASE_DEADLINE_MS = 120_000;

  async function watchdogTick(): Promise<void> {
    // 1. Liveness + recovery for active leases.
    const active = db()
      .prepare("SELECT * FROM gpu_leases WHERE state IN ('ready','provisioning','recovering')")
      .all() as LeaseRow[];
    for (const lease of active) {
      // Priority lane: skip if a release is in progress. The release owns the
      // instance exclusively — the watchdog must not probe the tunnel or try to
      // re-establish it while the release is stopping/destroying.
      if (releasePending.has(lease.instance_id)) continue;
      // Serialize per-instance.
      await withLock(lease.instance_id, async () => checkAndRecover(lease)).catch((e) =>
        console.error(`[watchdog] ${lease.instance_id}:`, (e as Error).message),
      );
    }
    // 2. Reap stranded/incomplete release rows. Two sub-cases:
    //    - 'releasing' older than STALE_RELEASING_MS: releaseImpl was killed.
    //      Finalize it (sync is best-effort again here, then destroy + terminal).
    //    - 'destroyed' with a non-null vast_id: a manual release marked the row
    //      terminal but its background destroy didn't finish (process killed).
    //      Destroy the lingering instance + null the fields.
    await reapReleases();
  }

  /**
   * Finalize release rows left incomplete by a killed process. Idempotent: a
   * successful manual release leaves state='destroyed' with vast_id=null, so the
   * destroyed-with-vast_id query returns nothing for it. Each reap runs under
   * the per-instance lock so it can't race acquire/watchdog for the same row.
   */
  async function reapReleases(): Promise<void> {
    // Two independent stranded-release conditions (either fires the reaper):
    //  - last_activity is older than STALE_RELEASING_MS (the pre-existing check,
    //    now reliable because touch() no longer refreshes releasing rows), OR
    //  - releasing_since is older than RELEASE_DEADLINE_MS (a poller-independent
    //    wall-clock backstop — a release that's been in flight >120s is force-
    //    completed regardless of what the poller is doing to last_activity).
    const staleReleasing = db()
      .prepare(
        `SELECT * FROM gpu_leases
         WHERE state = 'releasing'
           AND (last_activity < ? OR (releasing_since IS NOT NULL AND releasing_since < ?))`,
      )
      .all(now() - STALE_RELEASING_MS, now() - RELEASE_DEADLINE_MS) as LeaseRow[];
    for (const lease of staleReleasing) {
      // Priority lane: if the release's background IIFE is still running (flag
      // is set), skip — it will complete the release. Only force-complete if
      // the IIFE crashed (flag is NOT set but the row is still `releasing`).
      if (releasePending.has(lease.instance_id)) continue;
      await withLock(lease.instance_id, async () => {
        const cur = getLease(lease.instance_id);
        if (!cur || cur.state !== "releasing") return; // resolved since the query
        const sinceMs = cur.releasing_since ?? cur.last_activity;
        console.warn(`[watchdog] ${lease.instance_id}: reaping stranded 'releasing' row (in flight ${Math.round((now() - sinceMs) / 1000)}s ago)`);
        const container = db()
          .prepare("SELECT * FROM containers WHERE user_id = ?")
          .get(cur.user_id) as ContainerRow | undefined;
        if (container) await saveSyncAndStopTunnel(cur, container).catch(() => {});
        if (cur.vast_id) await destroyInstanceWithRetry(cur.vast_id).catch(() => {});
        if (cur.ssh_key_id) await vast.deleteSshKey(cur.ssh_key_id).catch(() => {});
        // A stranded release is one whose releaseImpl was killed mid-destroy.
        // For a MANUAL release (manually_released=1) the user explicitly stopped
        // the GPU — finalize to the terminal `destroyed` state so the row
        // PERSISTS and the lane does NOT auto-reacquire on remount. For a
        // non-manual release (idle-timeout / lane-deleted) the row should be
        // gone so the next view auto-acquires fresh — delete it, matching the
        // non-manual release path.
        if (cur.manually_released === 1) {
          upsertLease({
            ...cur,
            state: "destroyed",
            vast_id: null,
            ssh_host: null,
            ssh_port: null,
            ssh_key_id: null,
            releasing_since: null,
          });
        } else {
          deleteLease(cur.instance_id);
        }
      }).catch((e) => console.error(`[watchdog] reap releasing ${lease.instance_id}:`, (e as Error).message));
    }

    const unfinishedDestroyed = db()
      .prepare("SELECT * FROM gpu_leases WHERE state = 'destroyed' AND vast_id IS NOT NULL")
      .all() as LeaseRow[];
    for (const lease of unfinishedDestroyed) {
      // Priority lane: skip if the release's background IIFE is still running
      // (it will null vast_id when it completes). Only force-complete if the
      // IIFE crashed leaving vast_id set.
      if (releasePending.has(lease.instance_id)) continue;
      await withLock(lease.instance_id, async () => {
        const cur = getLease(lease.instance_id);
        if (!cur || cur.state !== "destroyed" || !cur.vast_id) return;
        console.warn(`[watchdog] ${lease.instance_id}: finalizing unfinished destroy for vast_id ${cur.vast_id}`);
        await destroyInstanceWithRetry(cur.vast_id).catch(() => {});
        const after = getLease(lease.instance_id);
        if (after && after.state === "destroyed") {
          upsertLease({ ...after, vast_id: null, ssh_key_id: null });
        }
      }).catch((e) => console.error(`[watchdog] reap destroyed ${lease.instance_id}:`, (e as Error).message));
    }
  }

  async function checkAndRecover(lease: LeaseRow): Promise<void> {
    const current = getLease(lease.instance_id);
    if (!current) return;
    // Re-check the live state inside the lock. A release may have flipped the
    // row to releasing/destroyed between the watchdog's SELECT and here.
    if (current.state === "releasing" || current.state === "destroyed") return;
    // If the user explicitly released this GPU, NEVER auto-recover — even if a
    // stale watchdog snapshot selected it. Recovery is for genuine crashes only.
    if (current.manually_released === 1) return;
    // Use the LIVE vast_id, not the captured snapshot's. A prior reProvision may
    // have nulled then reset vast_id; acting on a stale value could destroy the
    // wrong instance or spin up a duplicate.
    const vastId = current.vast_id;
    const sshHost = current.ssh_host;
    const sshPort = current.ssh_port;
    if (!vastId) return;

    const inst = await vast.getInstance(vastId).catch(() => null);
    const container = db()
      .prepare("SELECT * FROM containers WHERE user_id = ?")
      .get(lease.user_id) as ContainerRow | undefined;

    // ── RUNNING: check Blender + tunnel health ──────────────────────────────
    if (inst && inst.cur_state === "running") {
      // Only check tunnel for leases that are ready (not still provisioning).
      if (sshHost && sshPort && container && current.state === "ready") {
        // Protocol-level probe: send a real get_scene_info request through the
        // tunnel and check for a response. The old /dev/tcp probe only checked
        // whether the SSH tunnel's local forward accepted a TCP connection —
        // which it does even when Blender behind it has segfaulted (SSH accepts
        // locally, then gets RST from the remote, but the probe already returned
        // "ok"). This probe catches a dead Blender process behind a live tunnel.
        //
        // 3 attempts, 1s apart: a single transient failure (addon busy with a
        // render, brief socket hiccup) must not trigger a restart cycle.
        const probeCmd =
          `python3 -c "` +
          `import socket, json; ` +
          `s = socket.socket(); s.settimeout(3); ` +
          `s.connect(('127.0.0.1', ${BLENDER_PORT})); ` +
          `s.sendall(json.dumps({'type':'get_scene_info','params':{}}).encode() + b'\\n'); ` +
          `d = s.recv(4096); print('ok' if d else 'dead'); s.close()" 2>/dev/null`;
        let alive = false;
        for (let attempt = 0; attempt < 3 && !alive; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
          const probe = await exec(container, ["bash", "-lc", `${probeCmd} && echo ok || echo dead`], {
            user: APP_USER,
          }).catch(() => ({ code: 1, stdout: "dead", stderr: "" }));
          if (probe.stdout.includes("ok")) alive = true;
        }
        if (!alive) {
          // Blender is dead but the instance is still running. Restart Blender
          // in-place — much cheaper than destroying + re-provisioning the whole
          // instance, and the agent's saved scene.blend is preserved.
          console.log(`[watchdog] ${lease.instance_id}: Blender socket dead (instance running), restarting Blender in-place`);
          upsertLease({ ...current, state: "recovering" });
          await writeWorkflowPhase(current, container, "recovering", {
            active: { op: "restart", label: "Blender crashed — restarting…" },
          });
          const restarted = await restartBlender(container, { host: sshHost, port: sshPort });
          if (restarted) {
            const fresh = getLease(lease.instance_id);
            if (fresh && fresh.state !== "releasing" && fresh.state !== "destroyed") {
              upsertLease({ ...fresh, state: "ready", last_activity: now(), last_error: null });
              await writeWorkflowPhase(fresh, container, "gpu_ready");
              console.log(`[watchdog] ${lease.instance_id}: Blender restarted in-place`);
            }
            return;
          }
          // In-place restart failed. Fall back to restarting the tunnel (the
          // old recovery path) — if that doesn't help, the next watchdog tick
          // will find the port still dead and the instance may need a full
          // re-provision via the non-running branch below.
          console.error(`[watchdog] ${lease.instance_id}: in-place Blender restart failed, restarting tunnel as fallback`);
          const fresh = getLease(lease.instance_id);
          if (fresh && fresh.state === "recovering") {
            upsertLease({ ...fresh, state: "ready", last_error: "Blender restart failed; tunnel restarted as fallback" });
          }
          await stopTunnel(container);
          await startTunnel(container, { host: sshHost, port: sshPort });
        }
      }
      return;
    }

    // ── ANYTHING ELSE (paused, stopped, loading, exiting, error, gone):
    //    Try to resume the instance first (preserves data). If that fails,
    //    destroy and re-provision fresh with the saved .blend pushed back up.
    //    vast.ai uses several state names (paused, stopped, etc.) that all mean
    //    "not running but may be recoverable". Rather than enumerate them, we
    //    treat any non-running state the same way: attempt resume, fall back
    //    to re-provision.
    console.log(`[watchdog] ${lease.instance_id}: instance ${vastId} in state ${inst?.cur_state ?? "gone"}, attempting recovery`);
    upsertLease({ ...current, state: "recovering" });
    if (container) {
      await writeWorkflowPhase(current, container, "recovering", {
        active: { op: "recover", label: `GPU ${inst?.cur_state ?? "lost"} — reconnecting…` },
      });
    }
    if (inst) {
      // Instance still exists but isn't running. Try to start it.
      try {
        await vast.startInstance(vastId);
        await vast.waitForRunning(vastId);
        const target = await vast.sshUrl(vastId);
        if (target && container) {
          upsertLease({ ...current, ssh_host: target.host, ssh_port: target.port, state: "recovering" });
          await stopTunnel(container);
          await waitForBlenderSocket(container, target);
          await startTunnel(container, target);
        }
        upsertLease({ ...getLease(lease.instance_id)!, state: "ready", last_activity: now(), last_error: null });
        console.log(`[watchdog] ${lease.instance_id}: resumed instance ${vastId} from state ${inst.cur_state}`);
        return;
      } catch (e) {
        console.error(`[watchdog] ${lease.instance_id}: resume from ${inst.cur_state} failed, re-provisioning:`, (e as Error).message);
      }
    }
    // Instance gone or resume failed — re-provision fresh.
    await reProvision(current, container);
  }

  /** Destroy the dead instance and provision a fresh one, pushing the .blend up. */
  async function reProvision(lease: LeaseRow, container: ContainerRow | undefined): Promise<void> {
    if (!container) return;
    // Never auto-reprovision a manually-released GPU. The user explicitly gave
    // it up; recovery is for genuine crashes only.
    if (lease.manually_released === 1) {
      console.log(`[watchdog] ${lease.instance_id}: skipping re-provision (manually released)`);
      upsertLease({ ...lease, state: "destroyed", vast_id: null, ssh_host: null, ssh_port: null });
      return;
    }
    upsertLease({ ...lease, state: "recovering" });
    // Reset the workflow state so the viewport doesn't stay stuck on a stale
    // phase (e.g. "starting" from a render that was killed when the GPU died).
    await writeWorkflowPhase(lease, container, "recovering", {
      active: { op: "recover", label: "GPU was lost — reconnecting…" },
      errors: [`GPU instance ${lease.vast_id} was lost; a new one is being provisioned.`],
    });
    // Destroy the dead instance WITHOUT swallowing failures. The old code did
    // `.catch(() => {})` then immediately created a fresh instance, so a failed
    // destroy + successful create left TWO billing instances under one lease
    // (with the old vast_id already nulled, hence untracked). Now: if destroy
    // fails after retries, we ABORT the re-provision and leave the lease
    // recovering with an error so the next watchdog tick retries, rather than
    // risk a second instance.
    if (lease.vast_id) {
      const destroyed = await destroyInstanceWithRetry(lease.vast_id);
      if (!destroyed) {
        const msg = `destroy of dead instance ${lease.vast_id} failed; deferring re-provision to next watchdog tick`;
        console.error(`[watchdog] ${lease.instance_id}: ${msg}`);
        upsertLease({ ...lease, state: "recovering", last_error: msg });
        return;
      }
    }
    upsertLease({ ...lease, state: "provisioning", vast_id: null, ssh_host: null, ssh_port: null });
    try {
      await provisionInstance({ ...lease, state: "provisioning" }, container, true /* resume */);
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[watchdog] ${lease.instance_id}: re-provision failed:`, msg);
      upsertLease({ ...lease, state: "queued", queue_requested_at: now(), last_error: msg });
    }
  }

  // ── Idle reaper ───────────────────────────────────────────────────────────

  async function idleReaperTick(): Promise<void> {
    const leases = db()
      .prepare("SELECT * FROM gpu_leases WHERE state IN ('ready','recovering')")
      .all() as LeaseRow[];
    for (const lease of leases) {
      if (now() - lease.last_activity > idleTimeoutMs) {
        // Skip if a release is already in progress (e.g. user clicked Release
        // at the same moment the idle timer fired).
        if (releasePending.has(lease.instance_id)) continue;
        console.log(`[idle-reaper] releasing idle lease ${lease.instance_id} (idle ${Math.round((now() - lease.last_activity) / 1000)}s)`);
        // Use the priority lane: set the flag so syncTick/watchdog skip this
        // instance, then call releaseImpl directly (no withLock — the flag is
        // our serialization). The non-manual path runs synchronously, so clear
        // the flag in finally when it completes.
        releasePending.add(lease.instance_id);
        try {
          await releaseImpl(lease.instance_id, "idle-timeout");
        } catch (e) {
          console.error(`[idle-reaper] release failed:`, (e as Error).message);
        } finally {
          releasePending.delete(lease.instance_id);
        }
      }
    }
  }

  // ── Periodic sync ─────────────────────────────────────────────────────────

  async function syncTick(): Promise<void> {
    const leases = db()
      .prepare("SELECT * FROM gpu_leases WHERE state = 'ready'")
      .all() as LeaseRow[];
    for (const lease of leases) {
      // Priority lane: skip if a release is in progress. The release's background
      // IIFE handles save/sync/stop/destroy independently — syncTick must not
      // queue behind it (or hold the lock while it does SSH that could hang).
      if (releasePending.has(lease.instance_id)) continue;
      const container = db()
        .prepare("SELECT * FROM containers WHERE user_id = ?")
        .get(lease.user_id) as ContainerRow | undefined;
      if (container) {

        await withLock(lease.instance_id, () => syncDown(lease, container)).catch(() => {});
      }
    }
  }

  // ── Queue pump ────────────────────────────────────────────────────────────

  /**
   * Run ONE queue-pump market search and stamp the diagnostic fields on every
   * queued lease (success OR failure). Returns the offers (empty array on
   * failure — the failure is recorded in queue_search_error, distinct from a
   * genuinely empty market).
   *
   * Extracted from queuePumpTick so retryQueued can reuse exactly the same
   * search + diagnostic logic for a single lease without waiting for the 20s
   * pump cadence.
   */
  async function probeQueueOffers(): Promise<{ ok: true; offers: Offer[] } | { ok: false; error: string }> {
    try {
      const offers = await vast.searchOffers({ limit: 1 });
      return { ok: true, offers };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Stamp queue_last_checked_at (always) and queue_search_error (on failure)
   *  on every currently-queued lease. Called after each probe. */
  function stampQueueDiagnostics(result: { ok: true } | { ok: false; error: string }): void {
    const ts = now();
    const errMsg = result.ok ? null : result.error;
    const rows = queuedLeases();
    for (const l of rows) {
      // Only write when something changed — avoids needless DB churn every 20s
      // in the steady state where the market keeps returning empty cleanly.
      if (l.queue_last_checked_at !== ts || l.queue_search_error !== errMsg) {
        upsertLease({ ...l, queue_last_checked_at: ts, queue_search_error: errMsg });
      }
    }
  }

  /**
   * If a queued lease has been waiting longer than queueTimeoutMs, give up:
   * move it to destroyed + manually_released=1 with a clear timeout message.
   * Reusing the "explicit release" terminal state means the existing Acquire
   * path (which clears manually_released) and the frontend "Acquire GPU"
   * button (shown for destroyed) both work with no new state or UI — the user
   * just sees the timeout message and a button to retry.
   *
   * Returns true if any lease was timed out (so the caller can skip further
   * work on that tick).
   */
  function reapExpiredQueued(nowMs: number): boolean {
    const queue = queuedLeases();
    if (queue.length === 0) return false;
    let reaped = false;
    for (const l of queue) {
      const requestedAt = l.queue_requested_at ?? l.acquired_at ?? nowMs;
      if (nowMs - requestedAt <= queueTimeoutMs) continue;
      const minutes = Math.round(queueTimeoutMs / 60_000);
      console.warn(
        `[queue-pump] lease ${l.instance_id} timed out after ${minutes}min in queue; moving to destroyed`,
      );
      // upsertLease intentionally does NOT update manually_released (it's
      // reserved for the explicit setManuallyReleased setter so ordinary state
      // transitions can't clobber it). Set the row fields first, then the flag.
      upsertLease({
        ...l,
        state: "destroyed",
        vast_id: null,
        queue_position: null,
        last_error: `Timed out waiting for an affordable GPU (${minutes} min). Click Acquire GPU to retry.`,
      });
      // manually_released=1 suppresses auto-reacquire (watchdog reProvision +
      // frontend lane-open effect) until the user explicitly clicks Acquire.
      setManuallyReleased(l.instance_id, 1);
      reaped = true;
    }
    if (reaped) reindexQueue();
    return reaped;
  }

  async function queuePumpTick(): Promise<void> {
    const queue = queuedLeases();
    if (queue.length === 0) return;

    // 1. Give up on leases that have waited past the timeout. Do this BEFORE
    //    the market probe so a permanently-unavailable market doesn't keep a
    //    lease queued forever (the original bug: invisible retries for 30 min).
    if (reapExpiredQueued(now())) {
      // If the head of the queue was reaped, the remaining queue may be empty
      // or reordered — re-read rather than operating on a stale snapshot.
      if (queuedLeases().length === 0) return;
    }

    // 2. Probe the market. Record the outcome on EVERY queued lease so the UI
    //    can distinguish "still trying, market empty" from "search itself is
    //    broken" — previously .catch(() => []) conflated these, hiding CLI/auth
    //    failures behind a permanent "no qualifying GPU offers under cap".
    const result = await probeQueueOffers();
    stampQueueDiagnostics(result);
    if (!result.ok || result.offers.length === 0) return; // still no affordable offer

    // 3. Grant the head of the queue.
    const next = queuedLeases()[0];
    const container = db()
      .prepare("SELECT * FROM containers WHERE user_id = ?")
      .get(next.user_id) as ContainerRow | undefined;
    if (!container) return;
    // Atomically reserve a slot and promote queued → provisioning. Doing the
    // capacity check + the row update in one transaction closes the TOCTOU
    // window where two pump ticks (or a pump + an acquire) could both pass the
    // count and both provision, exceeding maxConcurrent.
    const promoted = claimConcurrencySlot(
      { ...next, queue_position: null },
      maxConcurrent,
    );
    if (!promoted) return;
    await withLock(next.instance_id, () => provisionInstance(getLease(next.instance_id)!, container, true)).catch((e) => {
      const msg = (e as Error).message;
      console.error(`[queue-pump] provision failed for ${next.instance_id}:`, msg);
      const cur = getLease(next.instance_id) ?? next;
      upsertLease({ ...cur, state: "queued", vast_id: null, queue_requested_at: now(), last_error: msg });
    });
    // Re-index remaining queue positions.
    reindexQueue();
  }

  /**
   * Force an immediate queue-pump attempt for a single queued lease (the
   * "Retry now" button). Runs the same probe → grant path as queuePumpTick
   * but scoped to `instanceId`, without waiting for the 20s cadence. No-op if
   * the lease is absent or not queued.
   */
  async function retryQueuedImpl(instanceId: string): Promise<void> {
    const lease = getLease(instanceId);
    if (!lease || lease.state !== "queued") {
      // Nothing to retry. Don't throw — the frontend calls this optimistically
      // and a stale row shouldn't surface as an error.
      return;
    }
    const container = db()
      .prepare("SELECT * FROM containers WHERE user_id = ?")
      .get(lease.user_id) as ContainerRow | undefined;
    if (!container) return;

    // Probe + stamp diagnostics for this one lease (mirrors queuePumpTick).
    const result = await probeQueueOffers();
    const ts = now();
    const errMsg = result.ok ? null : result.error;
    const pre = getLease(instanceId) ?? lease;
    const stamped: LeaseRow = { ...pre, queue_last_checked_at: ts, queue_search_error: errMsg };
    upsertLease(stamped);
    if (!result.ok || result.offers.length === 0) return;

    // An offer exists — try to provision this lease directly. Bypass the FIFO
    // head-of-queue ordering: the user explicitly asked to retry THIS lane.
    // NOTE: no inner withLock — retryQueued (the public method) already wraps
    // this in withLock(instanceId, …), and withLock is non-reentrant; a nested
    // lock on the same key would deadlock.
    const promoted = claimConcurrencySlot({ ...stamped, queue_position: null }, maxConcurrent);
    if (!promoted) return;
    try {
      await provisionInstance(getLease(instanceId) ?? stamped, container, true);
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[retry-queued] provision failed for ${instanceId}:`, msg);
      const cur = getLease(instanceId) ?? stamped;
      upsertLease({ ...cur, state: "queued", vast_id: null, queue_requested_at: now(), last_error: msg });
    }
    reindexQueue();
  }

  function reindexQueue(): void {
    const queue = queuedLeases();
    queue.forEach((l, i) => {
      if (l.queue_position !== i) upsertLease({ ...l, queue_position: i });
    });
  }

  // ── Brand asset push ──────────────────────────────────────────────────────

  /**
   * Push selected brand assets to the GPU instance. Reads brand_selection.json
   * from the workspace, resolves each selected asset, and SCPs it to
   * /root/assets/ on the GPU. Skips files that already match in size.
   */
  async function pushBrandAssetsImpl(instanceId: string): Promise<void> {
    const lease = getLease(instanceId);
    if (!lease || lease.state !== "ready" || !lease.ssh_host || !lease.ssh_port) return;
    const container = db()
      .prepare("SELECT * FROM containers WHERE user_id = ?")
      .get(lease.user_id) as ContainerRow | undefined;
    if (!container) return;

    // Read brand_selection.json from the workspace.
    const selectionPath = `/workspace/blends/${instanceId}/brand_selection.json`;
    const selRes = await exec(container, ["bash", "-lc", `cat '${selectionPath}' 2>/dev/null || true`], { user: APP_USER });
    if (!selRes.stdout.trim()) return;

    let assetIds: Set<string>;
    try {
      const sel = JSON.parse(selRes.stdout);
      assetIds = new Set<string>();
      for (const cat of Object.values(sel.assets ?? {})) {
        if (Array.isArray(cat)) for (const id of cat) if (typeof id === "string") assetIds.add(id);
      }
    } catch {
      return; // malformed selection — non-fatal
    }
    if (assetIds.size === 0) return;

    const scpBase = `ssh -i ${SSH_KEY_PATH} -p ${lease.ssh_port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10`;
    const scpOpts = `-i ${SSH_KEY_PATH} -P ${lease.ssh_port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10`;

    // Ensure /root/assets exists on the GPU instance.
    await exec(container, ["bash", "-lc", `${scpBase} root@${lease.ssh_host} 'mkdir -p /root/assets'`], { user: APP_USER }).catch(() => {});

    for (const id of assetIds) {
      // Resolve the local file path: /workspace/brand/assets/<id>.<ext>
      const found = await exec(container, ["bash", "-lc", `ls /workspace/brand/assets/${id}.* 2>/dev/null | head -1`], { user: APP_USER });
      const localPath = found.stdout.trim();
      if (!localPath) continue;
      const filename = localPath.split("/").pop()!;

      // Size-check: skip if the remote file already has the same size.
      const localSize = await localFileSize(container, localPath);
      const remoteSize = await remoteFileSize(container, lease.ssh_host, lease.ssh_port, `/root/assets/${filename}`);
      if (localSize !== null && remoteSize !== null && localSize === remoteSize) continue;

      await exec(
        container,
        ["bash", "-lc", `scp ${scpOpts} '${localPath}' 'root@${lease.ssh_host}:/root/assets/${filename}'`],
        { user: APP_USER },
      ).catch((e) => {
        console.warn(`[lease-manager] scp brand asset ${filename} failed:`, (e as Error).message);
      });
      console.log(`[lease-manager] pushed brand asset ${filename} to GPU instance`);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    acquire: (opts) => withLock(opts.instanceId, () => acquireImpl(opts)),
    /**
     * Release a GPU lease with PRIORITY over all other per-instance operations.
     *
     * This does NOT go through withLock — it writes the transitional state
     * synchronously (an atomic SQL statement that doesn't need serialization
     * with syncTick/watchdog) and starts the background save/sync/stop/destroy
     * work independently. The `releasePending` flag tells syncTick,
     * watchdogTick's checkAndRecover, idleReaperTick, and reapReleases to SKIP
     * this instance before they even try to acquire the lock. This means:
     *
     *   - Release is never queued behind a hung syncTick SSH command.
     *   - Once release writes `state: "releasing"`, no periodic operation
     *     touches the instance again — the background IIFE owns it exclusively.
     *   - Nothing can stop the release once it starts.
     *
     * For the manual path (the "Release GPU" button / DELETE /lease): writes
     * `releasing` synchronously, starts a detached background IIFE for the slow
     * work (save/sync/stop/destroy), and returns immediately. The `releasePending`
     * flag is cleared by the background IIFE's finally block when it completes
     * (or crashes — the reaper will force-complete on the next tick).
     *
     * For the non-manual path (idle-timeout / lane-deleted): writes `releasing`
     * synchronously, then runs save/sync/stop/destroy synchronously (the route
     * handler awaits this). The `releasePending` flag is cleared in the finally
     * block when the synchronous work completes.
     */
    release: async (instanceId: string, reason: string = "manual") => {
      // Idempotency: if a release is already in progress, don't start a second one.
      if (releasePending.has(instanceId)) return;
      releasePending.add(instanceId);
      try {
        await releaseImpl(instanceId, reason);
      } catch (e) {
        // releaseImpl threw before starting the background IIFE (manual path) or
        // before completing (non-manual path). Clear the flag so the reaper can
        // retry and syncTick/watchdog can resume normal operation.
        console.error(`[lease-manager] release failed for ${instanceId}:`, (e as Error).message);
        releasePending.delete(instanceId);
        return;
      }
      // For the non-manual path (synchronous), releaseImpl has completed all work
      // — clear the flag now. For the manual path, releaseImpl started a background
      // IIFE and returned; the IIFE's finally block clears the flag when it
      // completes (or crashes — the reaper force-completes on the next tick).
      if (reason !== "manual") {
        releasePending.delete(instanceId);
      }
    },
    touch: (instanceId) => {
      // Do NOT refresh last_activity for releasing/destroyed rows. The frontend
      // GET /lease poller calls touch() every 5s while the lane is open; without
      // this gate a stuck release's last_activity stays fresh forever and the
      // reaper never sees it as stranded. The releasing_since deadline is the hard
      // backstop, but this gate lets the faster STALE_RELEASING_MS path fire.
      db()
        .prepare(
          "UPDATE gpu_leases SET last_activity = ? WHERE instance_id = ? AND state NOT IN ('releasing','destroyed')",
        )
        .run(now(), instanceId);
    },
    get: getLease,
    retryQueued: (instanceId) => withLock(instanceId, () => retryQueuedImpl(instanceId)),
    start() {
      timers.push(setInterval(() => void watchdogTick(), watchdogIntervalMs));
      timers.push(setInterval(() => void syncTick(), syncIntervalMs));
      timers.push(setInterval(() => void queuePumpTick(), queuePumpIntervalMs));
      timers.push(setInterval(() => void idleReaperTick(), idleReaperIntervalMs));
    },
    stop() {
      while (timers.length) clearInterval(timers.pop());
    },
    pushBrandAssets: pushBrandAssetsImpl,
    /**
     * Restart Blender in-place on the GPU instance (agent-callable). SSHes into
     * the running instance, kills stale Blender, relaunches with the saved
     * scene.blend, and polls until the add-on socket responds. The agent calls
     * this via POST /api/workspace/<id>/blender/restart when it detects a dead
     * Blender. See restartBlender() above for details.
     */
    restartBlender: async (instanceId: string): Promise<{ ok: boolean; error?: string }> => {
      const lease = getLease(instanceId);
      if (!lease) return { ok: false, error: "no lease for this instance" };
      if (lease.state !== "ready" && lease.state !== "recovering") {
        return { ok: false, error: `lease is ${lease.state}, expected ready/recovering` };
      }
      if (!lease.ssh_host || !lease.ssh_port) return { ok: false, error: "no SSH endpoint on the lease" };
      const container = db()
        .prepare("SELECT * FROM containers WHERE user_id = ?")
        .get(lease.user_id) as ContainerRow | undefined;
      if (!container) return { ok: false, error: "agent container not found" };
      return withLock(instanceId, async () => {
        const current = getLease(instanceId);
        if (!current) return { ok: false, error: "lease disappeared" };
        upsertLease({ ...current, state: "recovering" });
        await writeWorkflowPhase(current, container, "recovering", {
          active: { op: "restart", label: "Restarting Blender…" },
        });
        const ok = await restartBlender(container, { host: lease.ssh_host!, port: lease.ssh_port! });
        if (!ok) {
          const fresh = getLease(instanceId);
          if (fresh && fresh.state === "recovering") {
            upsertLease({ ...fresh, state: "ready", last_error: "Blender restart failed" });
          }
          return { ok: false, error: "Blender add-on socket did not come back up" };
        }
        const fresh = getLease(instanceId);
        if (fresh && fresh.state !== "releasing" && fresh.state !== "destroyed") {
          upsertLease({ ...fresh, state: "ready", last_activity: now(), last_error: null });
          await writeWorkflowPhase(fresh, container, "gpu_ready");
        }
        return { ok: true };
      });
    },
  };
}

// ── Singleton ───────────────────────────────────────────────────────────────

let _manager: LeaseManager | null = null;

/**
 * The host-wide singleton lease manager. Started on first access. Uses the real
 * docker.ts execInContainer (imported at the top of this file). Unit tests that
 * need isolation call createLeaseManager() directly with injected exec/fileOps.
 */
export function leaseManager(): LeaseManager {
  if (!_manager) {
    _manager = createLeaseManager();
    _manager.start();
  }
  return _manager;
}

/**
 * TEST SEAM — never call from production code.
 *
 * Integration tests that drive the real route handlers (which call
 * `leaseManager()`) need to inject a manager built with a mocked vast client
 * and exec/fileOps. Without this seam, the routes would always reach the real
 * host singleton (which shells out to the `vastai` CLI and docker). This is the
 * only way to assert server-side state-machine behavior through the real API
 * layer without renting real GPUs.
 *
 * `mgr.start()` is the caller's responsibility (background loops are off by
 * default in tests that call methods directly; enabled where a test exercises
 * the watchdog/reaper). Always pair with `_clearLeaseManagerForTests()` in
 * afterEach to avoid leaking the mock across files.
 */
export function _setLeaseManagerForTests(mgr: LeaseManager): void {
  _manager = mgr;
}

/** TEST SEAM — clears any manager injected by `_setLeaseManagerForTests`. */
export function _clearLeaseManagerForTests(): void {
  _manager = null;
}
