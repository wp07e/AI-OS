import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Docker from "dockerode";
import { db, type ContainerRow, type UserRow } from "./db";

export const COMPOSE_FILE = resolve(process.cwd(), "compose", "user.compose.yml");

// Port pools. Single-host MVP — small ranges are plenty.
const OPENCODE_RANGE: [number, number] = [4100, 4199];
const OAUTH_RANGE: [number, number] = [19800, 19899];

const client = new Docker();

export const PROJECT_PREFIX = "aios";

export function projectFor(username: string): string {
  // sanitize: compose project names allow [a-z0-9_-], starting with a letter.
  const safe = username.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `${PROJECT_PREFIX}-${safe}`;
}

export function workspaceVolumeFor(username: string): string {
  const safe = username.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `aios-${safe}-workspace`;
}

/** Returns the parsed container row for a user, if any. */
export function getContainerForUser(userId: number): ContainerRow | null {
  const row = db()
    .prepare("SELECT * FROM containers WHERE user_id = ?")
    .get(userId) as ContainerRow | undefined;
  return row ?? null;
}

/** Allocates a fresh (opencode, oauth, relay) port triple. Relay = oauth + 1. */
function allocatePorts(): { opencode: number; oauth: number; relay: number } {
  const used = new Set<number>();
  for (const r of db()
    .prepare("SELECT opencode_port, oauth_port, relay_port FROM containers")
    .all() as Array<{ opencode_port: number; oauth_port: number; relay_port: number }>) {
    used.add(r.opencode_port);
    used.add(r.oauth_port);
    used.add(r.relay_port);
  }

  const pick = ([lo, hi]: [number, number]): number => {
    for (let p = lo; p <= hi; p++) if (!used.has(p)) return p;
    throw new Error(`port pool exhausted in [${lo}, ${hi}]`);
  };

  // Reserve opencode from its range.
  const opencode = pick(OPENCODE_RANGE);
  used.add(opencode);

  // Reserve a contiguous oauth/relay (relay = oauth + 1) from the oauth range.
  for (let p = OAUTH_RANGE[0]; p + 1 <= OAUTH_RANGE[1]; p++) {
    if (!used.has(p) && !used.has(p + 1)) {
      return { opencode, oauth: p, relay: p + 1 };
    }
  }
  throw new Error(`oauth port pool exhausted — no contiguous pair available`);
}

interface ComposeEnv {
  APP_UID: string;
  APP_GID: string;
  OPENAI_BASE_URL: string;
  OPENAI_API_KEY: string;
  XAI_API_KEY: string;
  LAYERRE_API_KEY: string;
  PUBLIC_BASE_URL: string;
  OPENCODE_PORT: string;
  OAUTH_PORT: string;
  RELAY_PORT: string;
  WORKSPACE_VOLUME: string;
}

/** Reads shared container env from ../container/.env, falling back to defaults. */
function loadContainerEnv(): Omit<
  ComposeEnv,
  "OPENCODE_PORT" | "OAUTH_PORT" | "RELAY_PORT" | "WORKSPACE_VOLUME"
> {
  const envPath = resolve(process.cwd(), "..", "container", ".env");
  const parsed: Record<string, string> = {};
  try {
    // Lightweight dotenv — no extra dep required.
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) parsed[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // .env optional in dev — fall back to process.env.
  }

  return {
    APP_UID: parsed.APP_UID ?? process.env.APP_UID ?? "2000",
    APP_GID: parsed.APP_GID ?? process.env.APP_GID ?? "2000",
    OPENAI_BASE_URL:
      parsed.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "http://litellm:4000/v1",
    OPENAI_API_KEY: parsed.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    XAI_API_KEY: parsed.XAI_API_KEY ?? process.env.XAI_API_KEY ?? "",
    LAYERRE_API_KEY: parsed.LAYERRE_API_KEY ?? process.env.LAYERRE_API_KEY ?? "",
    // Public base URL for the asset proxy (Tier 2 asset embedding). Empty in
    // dev → pipeline falls back to Tier 1 (describe-only).
    PUBLIC_BASE_URL: parsed.PUBLIC_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? "",
  };
}

function ensureVolume(name: string): Promise<void> {
  return client.createVolume({ Name: name }).then(
    () => undefined,
    (err: { statusCode?: number }) => {
      if (err.statusCode === 409) return; // already exists — fine
      throw err;
    },
  );
}

async function ensureNetwork(name: string): Promise<void> {
  try {
    await client.getNetwork(name).inspect();
  } catch {
    throw new Error(
      `Docker network '${name}' not found. Run \`docker compose -f container/docker-compose.yml up -d litellm\` first.`,
    );
  }
}

/** Returns the working directory for the user, or null on failure. */
function runCompose(
  args: string[],
  envFile: string,
  onStdout?: (chunk: string) => void,
  onStderr?: (chunk: string) => void,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      "docker",
      ["compose", "--env-file", envFile, "-f", COMPOSE_FILE, ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stdout?.on("data", (d) => onStdout?.(d.toString()));
    proc.stderr?.on("data", (d) => onStderr?.(d.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => resolvePromise(code ?? 0));
  });
}

export interface LaunchResult {
  row: ContainerRow;
}

// Per-user in-flight launch mutexes. React Strict Mode (Next.js dev default)
// mounts→unmounts→remounts components, so the launching page fires
// POST /api/launch twice concurrently on mount. Without serialization both
// calls race into `docker compose up` for the same project; one wins, the
// other hits a port/container conflict and returns a misleading 500. This
// map coalesces concurrent calls for the same user into a single launch.
const inflightLaunches = new Map<number, Promise<LaunchResult>>();

/** Launches (or reuses) a per-user container. Idempotent per user. */
export async function launchForUser(user: UserRow): Promise<LaunchResult> {
  const existing = getContainerForUser(user.id);
  if (existing && existing.status === "ready") {
    return { row: existing };
  }

  // If a launch is already running for this user, await it instead of racing.
  const inflight = inflightLaunches.get(user.id);
  if (inflight) return inflight;

  const p = doLaunch(user).finally(() => inflightLaunches.delete(user.id));
  inflightLaunches.set(user.id, p);
  return p;
}

async function doLaunch(user: UserRow): Promise<LaunchResult> {
  const existing = getContainerForUser(user.id);
  if (existing && existing.status === "ready") {
    return { row: existing };
  }

  // Re-use the existing allocation if present (e.g. relaunch after stop).
  const ports =
    existing && existing.status !== "ready"
      ? {
          opencode: existing.opencode_port,
          oauth: existing.oauth_port,
          relay: existing.relay_port,
        }
      : allocatePorts();

  const projectName = projectFor(user.username);
  const workspaceVolume = workspaceVolumeFor(user.username);

  await ensureNetwork("ai-os_ai-os-net");
  await ensureVolume(workspaceVolume);

  // Compose env file. Per-user ports + workspace volume override shared base.
  const env: ComposeEnv = {
    ...loadContainerEnv(),
    OPENCODE_PORT: String(ports.opencode),
    OAUTH_PORT: String(ports.oauth),
    RELAY_PORT: String(ports.relay),
    WORKSPACE_VOLUME: workspaceVolume,
  };
  const envDir = mkdtempSync(join(tmpdir(), "aios-env-"));
  const envFile = join(envDir, "compose.env");
  writeFileSync(
    envFile,
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );

  try {
    const upCode = await runCompose(
      ["-p", projectName, "up", "-d", "--pull", "never"],
      envFile,
    );
    if (upCode !== 0) throw new Error(`docker compose up exited with code ${upCode}`);

    // Resolve the actual container id so we can inspect/stop it later.
    const ps = await runComposeJson(["-p", projectName, "ps", "--format", "json"], envFile);
    const services = ps
      .filter((s) => s.Service === "ai-os")
      .map((s) => s.Id ?? s.ID ?? "");
    const containerId = services[0] ?? null;

    const row: ContainerRow = {
      user_id: user.id,
      project_name: projectName,
      opencode_port: ports.opencode,
      oauth_port: ports.oauth,
      relay_port: ports.relay,
      container_id: containerId,
      status: "launching",
      created_at: existing?.created_at ?? Date.now(),
    };

    db()
      .prepare(
        `INSERT INTO containers
           (user_id, project_name, opencode_port, oauth_port, relay_port, container_id, status, created_at)
         VALUES (@user_id, @project_name, @opencode_port, @oauth_port, @relay_port, @container_id, @status, @created_at)
         ON CONFLICT(user_id) DO UPDATE SET
           project_name=excluded.project_name,
           opencode_port=excluded.opencode_port,
           oauth_port=excluded.oauth_port,
           relay_port=excluded.relay_port,
           container_id=excluded.container_id,
           status=excluded.status`,
      )
      .run(row);

    return { row };
  } finally {
    rmSync(envDir, { recursive: true, force: true });
  }
}

interface ComposePsEntry {
  Service?: string;
  ID?: string;
  Id?: string;
}

function runComposeJson(args: string[], envFile: string): Promise<ComposePsEntry[]> {
  return new Promise((resolveP, reject) => {
    const proc = spawn(
      "docker",
      ["compose", "--env-file", envFile, "-f", COMPOSE_FILE, ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString()));
    proc.stderr?.on("data", () => {}); // swallow
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`compose ${args.join(" ")} exited ${code}`));
      try {
        // `ps --format json` emits one JSON object per line.
        const lines = out.split("\n").filter((l) => l.trim().startsWith("{"));
        resolveP(lines.map((l) => JSON.parse(l) as ComposePsEntry));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Polls the opencode server until it reports healthy (GET /global/health) or
 * times out. Falls back to a TCP probe so we still detect a partially-booted
 * server that hasn't wired /health yet.
 */
export async function waitForReady(
  row: ContainerRow,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 1500;
  const deadline = Date.now() + timeoutMs;

  // Lazy import to keep this module free of a hard runtime cycle with opencode.ts.
  const { isOpencodeReady } = await import("./opencode");

  while (Date.now() < deadline) {
    if (await isOpencodeReady(row.opencode_port)) {
      db().prepare("UPDATE containers SET status = ? WHERE user_id = ?").run("ready", row.user_id);
      return true;
    }
    await sleep(intervalMs);
  }
  db().prepare("UPDATE containers SET status = ? WHERE user_id = ?").run("error", row.user_id);
  return false;
}

export async function stopForUser(userId: number): Promise<void> {
  const row = getContainerForUser(userId);
  if (!row) return;
  const envFile = writeTransientEnv(row);
  try {
    // `stop` (not `down`): halt the process but KEEP the container object so the
    // same container (same Docker container ID) resumes in place on the user's
    // next login. `down` would remove it and a new container ID would be created
    // on relaunch. RAM is freed either way; user data lives in the external
    // workspace volume and is safe under both. `restart: unless-stopped` in the
    // compose file means a stopped container isn't auto-restarted by the daemon
    // but IS started by the next `compose up -d`.
    await runCompose(["-p", row.project_name, "stop"], envFile);
    db().prepare("UPDATE containers SET status = ? WHERE user_id = ?").run("stopped", userId);
  } finally {
    rmSync(envFile, { recursive: false, force: true });
  }
}

/**
 * Fully tears down a user's Docker footprint: stops + removes their container
 * AND deletes their per-user workspace volume (all lane files, OpenCode state,
 * cached Canva OAuth tokens). Used by account deletion (self-service and admin).
 *
 * Errors are logged, not thrown: a stuck Docker resource must never block a DB
 * account purge (the user must always be able to leave). The DB `ON DELETE
 * CASCADE` cleans up the `containers` row and all other child rows afterward.
 */
export async function purgeForUser(user: UserRow): Promise<void> {
  const row = getContainerForUser(user.id);
  if (row) {
    const envFile = writeTransientEnv(row);
    try {
      // `down` (not `stop`): actually remove the container on account deletion.
      await runCompose(["-p", row.project_name, "down"], envFile);
    } catch (err) {
      console.error(`[purge] compose down failed for ${user.username}`, err);
    } finally {
      rmSync(envFile, { recursive: false, force: true });
    }
  }

  // Remove the per-user workspace volume (external named volume — `down` alone
  // would leave it behind). This is where lane files + Canva tokens live.
  try {
    await client.getVolume(workspaceVolumeFor(user.username)).remove({ force: true });
  } catch (err) {
    console.error(`[purge] volume remove failed for ${user.username}`, err);
  }
}

/**
 * Restarts the user's ai-os container. Used after Canva OAuth completes —
 * opencode only registers the MCP on a fresh process start, so without a
 * restart the agent can't see Canva even though the tokens now exist.
 *
 * `docker compose restart` preserves the port mapping and the workspace volume;
 * only the process tree is recreated. We mark the container "launching" again
 * and proactively invalidate all of the user's cached opencode sessions: the
 * port stays the same after restart, so the (user, instance, port) cache guard
 * would otherwise hand back session ids that the restarted server no longer
 * knows about.
 */
export async function restartForUser(userId: number): Promise<void> {
  const row = getContainerForUser(userId);
  if (!row) throw new Error("no container for user");
  const envFile = writeTransientEnv(row);
  // Invalidate cached sessions BEFORE the restart so concurrent callers don't
  // observe a stale id during the brief restart window.
  db().prepare("DELETE FROM opencode_sessions WHERE user_id = ?").run(userId);
  db().prepare("UPDATE containers SET status = ? WHERE user_id = ?").run("launching", userId);
  try {
    const code = await runCompose(["-p", row.project_name, "restart", "ai-os"], envFile);
    if (code !== 0) throw new Error(`docker compose restart exited with code ${code}`);
  } finally {
    rmSync(envFile, { recursive: false, force: true });
  }
}

/** Writes a minimal env file with the ports needed by `compose down`. */
function writeTransientEnv(row: ContainerRow): string {
  const envFile = join(mkdtempSync(join(tmpdir(), "aios-stop-")), "compose.env");
  writeFileSync(
    envFile,
    [
      `APP_UID=2000`,
      `APP_GID=2000`,
      `OPENAI_BASE_URL=http://litellm:4000/v1`,
      `OPENAI_API_KEY=`,
      `XAI_API_KEY=`,
      `LAYERRE_API_KEY=`,
      `OPENCODE_PORT=${row.opencode_port}`,
      `OAUTH_PORT=${row.oauth_port}`,
      `RELAY_PORT=${row.relay_port}`,
      `WORKSPACE_VOLUME=${workspaceVolumeFor("__stop__")}`,
    ].join("\n"),
  );
  return envFile;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── In-container command execution ─────────────────────────────────────────
//
// Used by the workflow layer (and later the workspace polling layer) to run
// commands inside a user's container as the container's app user — e.g.
// `mkdir -p /workspace/carousels/<id>`. The same `docker compose -p ... exec`
// pattern is used by oauth-bridge.ts; centralizing it here keeps the args
// consistent.

/**
 * Runs a command inside the user's ai-os container. Returns { code, stdout }.
 * Throws if docker itself fails to spawn (a non-zero exit code is returned,
 * not thrown — callers decide how to handle it).
 */
export function execInContainer(
  row: ContainerRow,
  command: string[],
  opts: { user?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveP, reject) => {
    const args = [
      "compose",
      "-p",
      row.project_name,
      "-f",
      COMPOSE_FILE,
      "exec",
      ...(opts.user ? ["--user", opts.user] : []),
      "ai-os",
      ...command,
    ];
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => resolveP({ code: code ?? 0, stdout, stderr }));
  });
}

// ─── Workspace file access ──────────────────────────────────────────────────
//
// The workspace lives inside the container (/workspace/<folder>/<id>), mounted
// via a Docker volume. The host Next.js reads it via `docker compose exec`,
// keeping the exec pattern centralized here rather than reaching into Docker's
// volume driver. The skill (in-container) writes files; the canvas (host) reads
// them through these helpers + the /api/workspace/* routes.
//
// All paths are container-absolute. Routes resolve them from the workflow
// instance's `folder` column (already /workspace/...) after ownership checks.

const APP_USER = "appuser";

/**
 * Reads a workspace file as UTF-8 text. Returns null if the file is missing
 * (exit code 1 from cat); callers treat absence as non-fatal per the design
 * contract (canvas shows "working…" and keeps polling).
 */
export async function readWorkspaceFileText(
  row: ContainerRow,
  path: string,
): Promise<string | null> {
  const r = await execInContainer(row, ["cat", path], { user: APP_USER });
  if (r.code !== 0) return null; // file missing or unreadable → null, not throw
  return r.stdout;
}

/**
 * Reads a workspace file as a Buffer (for binary assets: PNG, PDF, etc.).
 * Returns null if the file is missing.
 */
export async function readWorkspaceFileBuffer(
  row: ContainerRow,
  path: string,
): Promise<Buffer | null> {
  return new Promise((resolveP, reject) => {
    const args = [
      "compose",
      "-p",
      row.project_name,
      "-f",
      COMPOSE_FILE,
      "exec",
      "--user",
      APP_USER,
      "ai-os",
      "cat",
      path,
    ];
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0) resolveP(null); // missing file → null
      else resolveP(Buffer.concat(chunks));
    });
  });
}

/**
 * Lists the files (relative names) in a workspace directory, non-recursively.
 * Returns [] if the directory is missing.
 */
export async function listWorkspaceDir(
  row: ContainerRow,
  path: string,
): Promise<string[]> {
  // `ls -1A` gives one name per line, including dotfiles, excluding . and ..
  const r = await execInContainer(row, ["ls", "-1A", path], { user: APP_USER });
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * Probes whether a workspace path exists (file or directory).
 */
export async function workspacePathExists(
  row: ContainerRow,
  path: string,
): Promise<boolean> {
  // `test -e` is silent on success (exit 0) and silent on failure (exit 1).
  const r = await execInContainer(row, ["test", "-e", path], { user: APP_USER });
  return r.code === 0;
}

// ─── Workspace file writes ──────────────────────────────────────────────────
//
// The host writes workspace files by piping bytes into `cat > <path>` over
// `docker compose exec -T` (no TTY, clean stdin). Used by the brand library
// to persist brand.json and uploaded assets under /workspace/brand/.
//
// Callers build paths from server-controlled values (UUIDs + sanitized
// extensions) — never raw user input — so shell quoting is safe.

/**
 * Writes UTF-8 text to a workspace path, creating or overwriting the file.
 * The parent directory must already exist (use ensureWorkspaceDir first).
 * Throws on non-zero exit. stdin is closed after writing the payload.
 */
export function writeWorkspaceFileText(
  row: ContainerRow,
  path: string,
  text: string,
): Promise<void> {
  return writeViaStdin(row, path, Buffer.from(text, "utf8"));
}

/**
 * Writes a binary buffer to a workspace path. Same contract as
 * writeWorkspaceFileText. Used for uploaded image assets.
 */
export function writeWorkspaceFileBuffer(
  row: ContainerRow,
  path: string,
  buffer: Buffer,
): Promise<void> {
  return writeViaStdin(row, path, buffer);
}

function writeViaStdin(
  row: ContainerRow,
  path: string,
  payload: Buffer,
): Promise<void> {
  return new Promise((resolveP, reject) => {
    // `-T` disables TTY allocation so stdin is treated as a pipe. The sh -c
    // wrapper lets us redirect stdin to the target path; single-quoting the
    // path is safe because callers pass sanitized/controlled paths.
    const args = [
      "compose",
      "-p",
      row.project_name,
      "-f",
      COMPOSE_FILE,
      "exec",
      "-T",
      "--user",
      APP_USER,
      "ai-os",
      "sh",
      "-c",
      `cat > '${path}'`,
    ];
    const proc = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0) reject(new Error(`write failed (exit ${code}): ${stderr}`));
      else resolveP();
    });
    // Stream the payload in and close stdin so `cat` sees EOF.
    proc.stdin.end(payload);
  });
}

/**
 * Removes a workspace file (no-op if missing: `rm -f`). Throws on other errors.
 */
export async function removeWorkspaceFile(
  row: ContainerRow,
  path: string,
): Promise<void> {
  const r = await execInContainer(row, ["rm", "-f", path], { user: APP_USER });
  if (r.code !== 0) throw new Error(`rm failed (exit ${r.code}): ${r.stderr}`);
}

/**
 * Ensures a workspace directory exists (`mkdir -p`). Throws on failure.
 */
export async function ensureWorkspaceDir(
  row: ContainerRow,
  path: string,
): Promise<void> {
  const r = await execInContainer(row, ["mkdir", "-p", path], { user: APP_USER });
  if (r.code !== 0) throw new Error(`mkdir failed (exit ${r.code}): ${r.stderr}`);
}
