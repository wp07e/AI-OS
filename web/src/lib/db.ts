import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hashSync } from "bcryptjs";
import { defaultAvatarUrl } from "./avatar";

// Allow an explicit override (used by tests); default to <cwd>/data/aios.db.
export const DB_PATH = resolve(process.env.DB_PATH ?? process.cwd() + "/data/aios.db");

let _db: Database.Database | null = null;

/** Singleton DB handle. Migrations are idempotent and run on first open. */
export function db(): Database.Database {
  if (_db) return _db;
  return openDb();
}

/** Opens a fresh DB connection at DB_PATH, runs migrations, caches it. */
function openDb(): Database.Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });

  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");

  migrate(conn);
  migrateLegacyOpencodeSessions(conn);
  migrateOpencodeSessionsContainerId(conn);
  migrateAdminColumn(conn);
  migrateGpuLeasesLastError(conn);
  migrateGpuLeasesManuallyReleased(conn);
  migrateGpuLeasesQueueDiagnostics(conn);
  migrateGpuLeasesReleasingSince(conn);
  migrateGpuLeasesRecoveryColumns(conn);
  migrateGpuLeasesInetCost(conn);
  migrateGpuMachineHealth(conn);
  seedDefaultUser(conn);
  _db = conn;
  return conn;
}

/**
 * TEST-ONLY: closes the cached DB connection and resets the singleton so the
 * next `db()` call opens a fresh connection. This lets test files point at a
 * temp DB by setting process.env.DB_PATH before calling this. NEVER call this
 * in production code.
 */
export function _resetDbForTests(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      // already closed
    }
    _db = null;
  }
}

function migrate(conn: Database.Database) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      display_name  TEXT,
      avatar_url    TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS containers (
      user_id       INTEGER PRIMARY KEY,
      project_name  TEXT    NOT NULL,
      opencode_port INTEGER NOT NULL,
      oauth_port    INTEGER NOT NULL,
      relay_port    INTEGER NOT NULL,
      container_id  TEXT,
      status        TEXT    NOT NULL,
      created_at    INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- One row per piece of work (e.g. "Q3 tips carousel"). Each instance owns
    -- a workspace folder under /workspace/<folder>/<id> and a dedicated
    -- opencode session (see opencode_sessions below).
    CREATE TABLE IF NOT EXISTS workflow_instances (
      id            TEXT    PRIMARY KEY,
      user_id       INTEGER NOT NULL,
      workflow_type TEXT    NOT NULL,
      title         TEXT    NOT NULL,
      folder        TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'active',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Cached opencode session id for shared LIBRARIES (brand, templates, ...),
    -- keyed by (user, library_key). Separate from opencode_sessions because that
    -- table's workflow_instance_id has a FK to workflow_instances — libraries
    -- aren't instances, so a sentinel key would violate the FK. Same invalidation
    -- rules apply: reuse only if port AND container_id match.
    CREATE TABLE IF NOT EXISTS library_sessions (
      user_id       INTEGER NOT NULL,
      library_key   TEXT    NOT NULL,
      session_id    TEXT    NOT NULL,
      opencode_port INTEGER NOT NULL,
      container_id  TEXT,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (user_id, library_key),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Cached opencode session id, keyed by (user, workflow_instance). One
    -- OpenCode process per user container serves many sessions on one port; the
    -- session id is what gives each workflow lane its own bounded context.
    -- Mirrored on opencode_port so a container relaunch invalidates the cache.
    CREATE TABLE IF NOT EXISTS opencode_sessions (
      user_id              INTEGER NOT NULL,
      workflow_instance_id TEXT    NOT NULL,
      session_id           TEXT    NOT NULL,
      opencode_port        INTEGER NOT NULL,
      container_id         TEXT,   -- the container the session lives in; a recreate changes this even though the port doesn't, invalidating stale sessions
      created_at           INTEGER NOT NULL,
      PRIMARY KEY (user_id, workflow_instance_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(workflow_instance_id) REFERENCES workflow_instances(id) ON DELETE CASCADE
    );

    -- One row per Blender workflow instance that holds (or is waiting for) a
    -- vast.ai GPU lease. The host GPU Lease Manager (lib/gpu/lease-manager.ts)
    -- is the sole writer. A row exists from auto-acquire (on lane open) until
    -- release+destroy. state follows LeaseState (queued|provisioning|ready|
    -- recovering|releasing). last_activity drives the idle-timeout auto-
    -- release. vast_id is the rented instance id; ssh_host/port are the
    -- instance's SSH endpoint the in-container tunnel dials.
    CREATE TABLE IF NOT EXISTS gpu_leases (
      instance_id   TEXT    PRIMARY KEY,
      user_id       INTEGER NOT NULL,
      state         TEXT    NOT NULL,
      vast_id       INTEGER,          -- vast.ai instance id (null while queued)
      gpu_name      TEXT,             -- e.g. "RTX 4060"
      dph           REAL,             -- dollars per hour
      inet_cost     REAL,             -- combined inet_down+up cost in $/GB (usage-based, per Vast.ai)
      ssh_host      TEXT,
      ssh_port      INTEGER,
      ssh_key_id    INTEGER,          -- vast.ai SSH key id (cleaned up on release)
      queue_position INTEGER,         -- 0-based position when state=queued
      queue_requested_at INTEGER,     -- ms epoch, for FIFO ordering
      queue_last_checked_at INTEGER,  -- ms epoch of the last queue-pump search attempt (success or failure)
      queue_search_error TEXT,        -- null when the last market search succeeded; set to the error string when vastai/CLI/auth failed (distinct from a genuinely empty market)
      acquired_at   INTEGER,          -- ms epoch, when provisioning started
      last_activity INTEGER NOT NULL, -- ms epoch, bumped on every poll/render
      last_synced_at INTEGER,         -- ms epoch of the last successful .blend sync-down
      last_error     TEXT,            -- last provisioning/recovery error (surfaced to UI)
      manually_released INTEGER NOT NULL DEFAULT 0, -- 1 when the user explicitly released the GPU; suppresses auto-reacquire (watchdog reProvision + frontend lane-open effect) until an explicit Acquire clears it
      releasing_since INTEGER,          -- ms epoch when state entered 'releasing'; watchdog reaper force-completes a release older than RELEASE_DEADLINE_MS regardless of poller activity
      machine_id      INTEGER,          -- vast.ai physical host id of the current/pending instance; detects "same flaky machine re-picked" across destroy/re-create
      machine_fail_count INTEGER NOT NULL DEFAULT 0, -- consecutive init failures on the SAME machine_id (reset to 0 on success or when a different machine is picked)
      escalation_stage TEXT NOT NULL DEFAULT 'fresh', -- init-failure escalation: fresh | rebooting | post_blacklist | gave_up (see lease-manager escalation ladder)
      FOREIGN KEY(instance_id) REFERENCES workflow_instances(id) ON DELETE CASCADE
    );

    -- Physical-host health ledger. When a machine_id fails init AND a reboot
    -- fails to recover it, the host is blacklisted here for a TTL so it is never
    -- re-picked by searchOffers (see vast.ts excludeMachineIds). Survives lane
    -- destruction and process restarts, so a flaky host won't be re-acquired in
    -- a fresh lane. Query-time expiry: a row is treated as blacklisted iff
    -- blacklisted=1 AND blacklisted_at > now() - GPU_MACHINE_BLACKLIST_TTL_MS.
    CREATE TABLE IF NOT EXISTS gpu_machine_health (
      machine_id     INTEGER PRIMARY KEY,
      fail_count     INTEGER NOT NULL DEFAULT 0,  -- cumulative init failures ever observed (diagnostics)
      blacklisted    INTEGER NOT NULL DEFAULT 0,  -- 1 when the host is currently being avoided
      blacklisted_at INTEGER,                     -- ms epoch when blacklisted; null when not blacklisted
      last_failed_at INTEGER,                     -- ms epoch of the most recent init failure
      last_error     TEXT                         -- last failure message that led to blacklisting
    );
  `);
}

// Add last_error and ssh_key_id to pre-existing gpu_leases tables (idempotent).
export function migrateGpuLeasesLastError(conn: Database.Database): void {
  const cols = conn.prepare("PRAGMA table_info(gpu_leases)").all() as Array<{ name: string }>;
  if (cols.length === 0) return; // table doesn't exist yet — CREATE handles it
  if (!cols.some((c) => c.name === "last_error")) {
    conn.exec("ALTER TABLE gpu_leases ADD COLUMN last_error TEXT");
  }
  if (!cols.some((c) => c.name === "ssh_key_id")) {
    conn.exec("ALTER TABLE gpu_leases ADD COLUMN ssh_key_id INTEGER");
  }
}

/**
 * Add manually_released to pre-existing gpu_leases tables (idempotent).
 *
 * Tracks whether the user explicitly released the GPU. When 1, the lease row
 * is persisted in state "destroyed" and auto-reacquire is suppressed on both
 * the server (watchdog reProvision) and the client (lane-open effect) until an
 * explicit Acquire clears the flag. See lib/gpu/lease-manager.ts.
 */
export function migrateGpuLeasesManuallyReleased(conn: Database.Database): void {
  const cols = conn.prepare("PRAGMA table_info(gpu_leases)").all() as Array<{ name: string }>;
  if (cols.length === 0) return; // table doesn't exist yet — CREATE handles it
  if (!cols.some((c) => c.name === "manually_released")) {
    conn.exec("ALTER TABLE gpu_leases ADD COLUMN manually_released INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * Add queue diagnostics to pre-existing gpu_leases tables (idempotent).
 *
 * `queue_last_checked_at` records the last queue-pump market-search attempt
 * (success or failure), so the UI can show "still trying — last checked Ns
 * ago" instead of a frozen state. `queue_search_error` is null when the search
 * SUCCEEDED (even if empty) and set to the error string when the vastai
 * CLI/auth/network threw — this distinguishes a broken search from a genuinely
 * empty market, which `.catch(() => [])` previously conflated.
 */
export function migrateGpuLeasesQueueDiagnostics(conn: Database.Database): void {
  const cols = conn.prepare("PRAGMA table_info(gpu_leases)").all() as Array<{ name: string }>;
  if (cols.length === 0) return; // table doesn't exist yet — CREATE handles it
  if (!cols.some((c) => c.name === "queue_last_checked_at")) {
    conn.exec("ALTER TABLE gpu_leases ADD COLUMN queue_last_checked_at INTEGER");
  }
  if (!cols.some((c) => c.name === "queue_search_error")) {
    conn.exec("ALTER TABLE gpu_leases ADD COLUMN queue_search_error TEXT");
  }
}

/**
 * Add releasing_since to pre-existing gpu_leases tables (idempotent).
 *
 * `releasing_since` is the ms-epoch timestamp at which a lease entered the
 * `releasing` state. The watchdog reaper uses it as a poller-independent
 * wall-clock deadline: if a release hasn't reached `destroyed` within
 * RELEASE_DEADLINE_MS, the reaper force-completes it — regardless of whether
 * the frontend's GET poll is still bumping `last_activity` (which it does
 * every 5s while the lane is open, defeating the old last_activity-only check).
 */
export function migrateGpuLeasesReleasingSince(conn: Database.Database): void {
  const cols = conn.prepare("PRAGMA table_info(gpu_leases)").all() as Array<{ name: string }>;
  if (cols.length === 0) return; // table doesn't exist yet — CREATE handles it
  if (!cols.some((c) => c.name === "releasing_since")) {
    conn.exec("ALTER TABLE gpu_leases ADD COLUMN releasing_since INTEGER");
  }
}

/**
 * Add machine-init-failure escalation columns to pre-existing gpu_leases tables.
 *
 * `machine_id` records the physical host of the current/pending instance so the
 * lease manager can detect "the same flaky machine keeps being re-picked" across
 * destroy/re-create cycles. `machine_fail_count` tracks consecutive init
 * failures on that same machine. `escalation_stage` drives the escalation ladder
 * (fresh → rebooting → post_blacklist → gave_up) described in lease-manager.ts.
 * All reset to defaults on a successful provision or an explicit re-acquire.
 */
export function migrateGpuLeasesRecoveryColumns(conn: Database.Database): void {
  const cols = conn.prepare("PRAGMA table_info(gpu_leases)").all() as Array<{ name: string }>;
  if (cols.length === 0) return; // table doesn't exist yet — CREATE handles it
  if (!cols.some((c) => c.name === "machine_id")) {
    conn.exec("ALTER TABLE gpu_leases ADD COLUMN machine_id INTEGER");
  }
  if (!cols.some((c) => c.name === "machine_fail_count")) {
    conn.exec("ALTER TABLE gpu_leases ADD COLUMN machine_fail_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "escalation_stage")) {
    conn.exec("ALTER TABLE gpu_leases ADD COLUMN escalation_stage TEXT NOT NULL DEFAULT 'fresh'");
  }
}

/**
 * Add the inet_cost column to pre-existing gpu_leases tables (idempotent).
 *
 * Vast.ai charges usage-based Internet fees on top of the per-hour GPU rate
 * (inet_down_cost + inet_up_cost, both $/GB). `inet_cost` stores the combined
 * $/GB rate captured from the offer at acquire time, so the cost label can show
 * both rate types honestly (dph is time-based; inet_cost is usage-based). NULL
 * while queued / after release — same lifecycle as `dph`.
 */
export function migrateGpuLeasesInetCost(conn: Database.Database): void {
  const cols = conn.prepare("PRAGMA table_info(gpu_leases)").all() as Array<{ name: string }>;
  if (cols.length === 0) return; // table doesn't exist yet — CREATE handles it
  if (!cols.some((c) => c.name === "inet_cost")) {
    conn.exec("ALTER TABLE gpu_leases ADD COLUMN inet_cost REAL");
  }
}

/**
 * Ensure the gpu_machine_health table exists on pre-existing databases.
 *
 * On a clean-slate DB the CREATE TABLE in initSchema() already creates it; this
 * migration covers databases created before the table existed. Idempotent.
 */
export function migrateGpuMachineHealth(conn: Database.Database): void {
  const tables = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gpu_machine_health'").all();
  if (tables.length === 0) {
    conn.exec(`
      CREATE TABLE gpu_machine_health (
        machine_id     INTEGER PRIMARY KEY,
        fail_count     INTEGER NOT NULL DEFAULT 0,
        blacklisted    INTEGER NOT NULL DEFAULT 0,
        blacklisted_at INTEGER,
        last_failed_at INTEGER,
        last_error     TEXT
      );
    `);
  }
}

// Add container_id to pre-existing opencode_sessions tables (idempotent).
export function migrateOpencodeSessionsContainerId(conn: Database.Database): void {
  const cols = conn.prepare("PRAGMA table_info(opencode_sessions)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "container_id")) {
    conn.exec("ALTER TABLE opencode_sessions ADD COLUMN container_id TEXT");
  }
}

// ─── Legacy schema migration ────────────────────────────────────────────────
//
// M1 reshaped opencode_sessions from user-keyed to (user, workflow_instance)-
// keyed. The CREATE TABLE IF NOT EXISTS above won't touch a pre-M1 table, so
// detect the old shape and rebuild it. Testing assumes clean-slate resets, but
// this guard keeps a dev from hitting a confusing schema mismatch after pull.
export function migrateLegacyOpencodeSessions(conn: Database.Database): void {
  const cols = conn.prepare("PRAGMA table_info(opencode_sessions)").all() as Array<{ name: string }>;
  const hasWorkflowInstance = cols.some((c) => c.name === "workflow_instance_id");
  if (!hasWorkflowInstance) {
    conn.exec("DROP TABLE IF EXISTS opencode_sessions");
    conn.exec(`
      CREATE TABLE opencode_sessions (
        user_id              INTEGER NOT NULL,
        workflow_instance_id TEXT    NOT NULL,
        session_id           TEXT    NOT NULL,
        opencode_port        INTEGER NOT NULL,
        created_at           INTEGER NOT NULL,
        PRIMARY KEY (user_id, workflow_instance_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(workflow_instance_id) REFERENCES workflow_instances(id) ON DELETE CASCADE
      );
    `);
  }
}

// Add is_admin column to users table (idempotent).
function migrateAdminColumn(conn: Database.Database): void {
  const cols = conn.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "is_admin")) {
    conn.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  }
  // Ensure the seed user is flagged as admin (reads from SEED_USERNAME).
  const seedUser = process.env.SEED_USERNAME;
  if (seedUser) {
    conn.prepare("UPDATE users SET is_admin = 1 WHERE username = ?").run(seedUser);
  }
}

// Ensure the default seed user always exists (idempotent).
// Credentials come from SEED_USERNAME / SEED_PASSWORD env vars.
// If either is missing, seeding is skipped (with a warning on first run).
function seedDefaultUser(conn: Database.Database): void {
  const username = process.env.SEED_USERNAME;
  const password = process.env.SEED_PASSWORD;
  if (!username || !password) {
    const hasUsers = conn.prepare("SELECT count(*) as c FROM users").get() as { c: number };
    if (hasUsers.c === 0) {
      console.warn(
        "[db] No users in database and SEED_USERNAME / SEED_PASSWORD not set. " +
        "Set them in web/.env.local to auto-create a default user.",
      );
    }
    return;
  }

  const existing = conn.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) return;

  const hash = hashSync(password, 10);
  conn.prepare(
    `INSERT INTO users (username, password_hash, display_name, avatar_url, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    username,
    hash,
    username,
    defaultAvatarUrl(username),
    Date.now(),
  );
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string | null;
  avatar_url: string | null;
  is_admin: number;
  created_at: number;
}

export interface ContainerRow {
  user_id: number;
  project_name: string;
  opencode_port: number;
  oauth_port: number;
  relay_port: number;
  container_id: string | null;
  status: string;
  created_at: number;
}

export interface WorkflowInstanceRow {
  id: string;
  user_id: number;
  workflow_type: string;
  title: string;
  folder: string;
  status: string;
  created_at: string;
  updated_at: string;
}
