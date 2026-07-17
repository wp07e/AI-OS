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
import type { LeaseState } from "./types";

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
          queue_position, queue_requested_at, acquired_at, last_activity, last_synced_at, last_error,
          manually_released)
       VALUES (@instance_id, @user_id, @state, @vast_id, @gpu_name, @dph, @ssh_host, @ssh_port, @ssh_key_id,
          @queue_position, @queue_requested_at, @acquired_at, @last_activity, @last_synced_at, @last_error,
          @manually_released)
       ON CONFLICT(instance_id) DO UPDATE SET
         state=excluded.state, vast_id=excluded.vast_id, gpu_name=excluded.gpu_name,
         dph=excluded.dph, ssh_host=excluded.ssh_host, ssh_port=excluded.ssh_port,
         ssh_key_id=excluded.ssh_key_id,
         queue_position=excluded.queue_position, acquired_at=excluded.acquired_at,
         last_activity=excluded.last_activity, last_synced_at=excluded.last_synced_at,
         last_error=excluded.last_error`,
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
}

export function createLeaseManager(config: LeaseManagerConfig = {}): LeaseManager {
  const vast = config.vast ?? defaultVast;
  const maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const watchdogIntervalMs = config.watchdogIntervalMs ?? 10_000;
  const syncIntervalMs = config.syncIntervalMs ?? 5_000;
  const queuePumpIntervalMs = config.queuePumpIntervalMs ?? 20_000;
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
      env: { GPU_SSH_PUBKEY: pubKey },
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
    // The tunnel runs as appuser. -N = no remote command, -f = background,
    // -L = local forward. Uses the container's own SSH key. ServerAliveInterval
    // keeps it from dying on idle.
    const cmd = [
      "bash",
      "-lc",
      `ssh -i ${SSH_KEY_PATH} -NfL ${BLENDER_PORT}:127.0.0.1:${BLENDER_PORT} -p ${target.port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=30 -o ServerAliveCountMax=3 root@${target.host} 2>/dev/null || true`,
    ];
    await exec(container, cmd, { user: APP_USER });
  }

  /** Kill the in-container SSH tunnel (best-effort). */
  async function stopTunnel(container: ContainerRow): Promise<void> {
    await exec(
      container,
      ["bash", "-lc", `pkill -f "ssh -NfL ${BLENDER_PORT}:" 2>/dev/null || true`],
      { user: APP_USER },
    ).catch(() => {});
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
      acquired_at: now(),
      last_activity: now(),
      last_synced_at: null,
      last_error: null,
      manually_released: 0,
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
      // nulled only when the row reaches `destroyed`.
      upsertLease({ ...lease, state: "releasing", manually_released: 1 });
      setManuallyReleased(instanceId, 1);
      // Background: save → sync → stop tunnel → destroy → delete ssh key →
      // terminal `destroyed` + null instance fields. Tracked so a second release
      // awaits it instead of racing; the watchdog reaper also finalizes stranded
      // `releasing` rows whose process was killed mid-destroy.
      const snapshot = { ...lease };
      void (async () => {
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
          });
        }
      })().catch((e) => console.error(`[lease-manager] background release failed for ${instanceId}:`, (e as Error).message));
      return;
    }

    // ── Non-manual release (idle-timeout, lane-deleted, …) ──────────────────
    // Same behavior as before: sync → destroy (in finally) → deleteLease. No row
    // remains, so the next lane open auto-acquires (state="none"). This keeps
    // crash/idle recovery "just works" — only an explicit user release suppresses
    // auto-reacquire.
    upsertLease({ ...lease, state: "releasing" });
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
   * reaps such rows so the UI never gets stuck on "Releasing…" forever.
   */
  const STALE_RELEASING_MS = 90_000;

  async function watchdogTick(): Promise<void> {
    // 1. Liveness + recovery for active leases.
    const active = db()
      .prepare("SELECT * FROM gpu_leases WHERE state IN ('ready','provisioning','recovering')")
      .all() as LeaseRow[];
    for (const lease of active) {
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
    const staleReleasing = db()
      .prepare(
        "SELECT * FROM gpu_leases WHERE state = 'releasing' AND last_activity < ?",
      )
      .all(now() - STALE_RELEASING_MS) as LeaseRow[];
    for (const lease of staleReleasing) {
      await withLock(lease.instance_id, async () => {
        const cur = getLease(lease.instance_id);
        if (!cur || cur.state !== "releasing") return; // resolved since the query
        console.warn(`[watchdog] ${lease.instance_id}: reaping stranded 'releasing' row (last_activity ${Math.round((now() - cur.last_activity) / 1000)}s ago)`);
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

    // ── RUNNING: check tunnel health ──────────────────────────────────────
    if (inst && inst.cur_state === "running") {
      // Only check tunnel for leases that are ready (not still provisioning).
      if (sshHost && sshPort && container && current.state === "ready") {
        const probe = await exec(
          container,
          ["bash", "-lc", `nc -z 127.0.0.1 ${BLENDER_PORT} 2>/dev/null && echo ok || echo dead`],
          { user: APP_USER },
        ).catch(() => ({ code: 1, stdout: "dead", stderr: "" }));
        if (!probe.stdout.includes("ok")) {
          await stopTunnel(container);
          await startTunnel(container, { host: sshHost, port: sshPort });
          console.log(`[watchdog] ${lease.instance_id}: re-established dead tunnel`);
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
        console.log(`[idle-reaper] releasing idle lease ${lease.instance_id} (idle ${Math.round((now() - lease.last_activity) / 1000)}s)`);
        // Run under the per-instance lock. releaseImpl does long async work
        // (save + sync + destroy); without the lock, a concurrent watchdog tick
        // could reProvision the same instance mid-release, creating a second GPU.
        await withLock(lease.instance_id, () => releaseImpl(lease.instance_id, "idle-timeout")).catch((e) =>
          console.error(`[idle-reaper] release failed:`, (e as Error).message),
        );
      }
    }
  }

  // ── Periodic sync ─────────────────────────────────────────────────────────

  async function syncTick(): Promise<void> {
    const leases = db()
      .prepare("SELECT * FROM gpu_leases WHERE state = 'ready'")
      .all() as LeaseRow[];
    for (const lease of leases) {
      const container = db()
        .prepare("SELECT * FROM containers WHERE user_id = ?")
        .get(lease.user_id) as ContainerRow | undefined;
      if (container) {
        
        await withLock(lease.instance_id, () => syncDown(lease, container)).catch(() => {});
      }
    }
  }

  // ── Queue pump ────────────────────────────────────────────────────────────

  async function queuePumpTick(): Promise<void> {
    const queue = queuedLeases();
    if (queue.length === 0) return;
    // Re-search to confirm a sub-cap offer exists before granting.
    const offers = await vast.searchOffers({ limit: 1 }).catch(() => []);
    if (offers.length === 0) return; // still no affordable offer
    const next = queue[0];
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
      upsertLease({ ...next, state: "queued", queue_requested_at: now(), last_error: msg });
    });
    // Re-index remaining queue positions.
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
    release: (instanceId, reason) => withLock(instanceId, () => releaseImpl(instanceId, reason)),
    touch: (instanceId) => {
      db().prepare("UPDATE gpu_leases SET last_activity = ? WHERE instance_id = ?").run(now(), instanceId);
    },
    get: getLease,
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
