/**
 * Shared test helpers for GPU lease integration tests.
 *
 * Two responsibilities:
 *
 *  1. Fixtures (mockVast, mockExec, mockFileOps, fakeContainer, seedBlenderLane)
 *     — lifted verbatim from lease-manager.test.ts so unit and integration
 *     tests share identical setup. Drift here = drift in coverage.
 *
 *  2. bootTestLeaseManager / callLeaseApi — the integration-test entrypoints.
 *     bootTestLeaseManager builds a real lease manager (real DB, real background
 *     loops, mocked vast/exec/fileOps) and installs it via the
 *     _setLeaseManagerForTests seam so the real route handlers reach the mock.
 *     callLeaseApi invokes a route handler (GET/POST/DELETE) directly, with
 *     `currentUser` stubbed to a seeded user.
 *
 * Why in-process (not HTTP): the route handlers are plain async functions
 * `(req, ctx) => Response`. Calling them directly avoids booting next dev,
 * keeps tests deterministic and fast (~ms), and lets us assert on the SAME
 * sqlite DB the manager writes to. The HTTP layer adds nothing here — the
 * regression lives below it, in the state machine.
 */

import { vi } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { db, _resetDbForTests } from "@/lib/db";
import {
  createLeaseManager,
  _setLeaseManagerForTests,
  _clearLeaseManagerForTests,
  type ContainerExec,
  type InstanceFileOps,
  type LeaseManager,
} from "@/lib/gpu/lease-manager";
import type { VastClient } from "@/lib/gpu/vast";
import type { Offer, Instance } from "@/lib/gpu/types";
import type { ContainerRow, UserRow } from "@/lib/db";

// ── DB bootstrap ────────────────────────────────────────────────────────────

/**
 * Point DB_PATH at a fresh temp file and (re)initialize the schema. Call once
 * per test file in beforeAll. Idempotent against already-cached db.ts.
 */
export function useTempDb(): string {
  const tmpDir = mkdtempSync(resolve(tmpdir(), "aios-gpu-int-"));
  const dbPath = resolve(tmpDir, "test.db");
  process.env.DB_PATH = dbPath;
  delete process.env.GPU_IMAGE; // force the default CUDA image for tests
  _resetDbForTests();
  db(); // initialize schema
  return dbPath;
}

// ── Fixtures (mirror lease-manager.test.ts) ─────────────────────────────────

export function fakeOffer(over: Partial<Offer> = {}): Offer {
  return {
    id: 100,
    gpu_name: "RTX 4060 Ti",
    num_gpus: 1,
    dph_total: 0.081,
    dlperf: 50,
    dlperf_per_dphtotal: 617,
    cuda_max_good: 12.6,
    rentable: true,
    ...over,
  };
}

export function fakeInstance(over: Partial<Instance> = {}): Instance {
  return {
    id: 500,
    cur_state: "running",
    gpu_name: "RTX 4060 Ti",
    dph_total: 0.081,
    ...over,
  };
}

export function fakeContainer(): ContainerRow {
  return {
    user_id: 1,
    project_name: "aios-test",
    opencode_port: 4100,
    oauth_port: 19800,
    relay_port: 19801,
    container_id: "abc123",
    status: "ready",
    created_at: Date.now(),
  };
}

/**
 * A mock vast client with vi.fn spies for every method.
 *
 * `createInstance` returns a DISTINCT sequential id per call (500, 501, 502, …)
 * so tests that acquire multiple lanes (4/5/6) can assert each got its own GPU.
 * The getInstance/waitForRunning mocks return a running instance reflecting the
 * requested id (so the manager records the right vast_id per lane).
 */
export function mockVast(overrides: Partial<VastClient> = {}): VastClient & {
  mocks: Record<string, ReturnType<typeof vi.fn>>;
} {
  let nextInstanceId = 500;
  const mocks = {
    showUser: vi.fn(async () => ({})),
    searchOffers: vi.fn(async (): Promise<Offer[]> => [fakeOffer()]),
    createInstance: vi.fn(async (): Promise<{ id: number }> => ({ id: nextInstanceId++ })),
    getInstance: vi.fn(async (id: number): Promise<Instance | null> => fakeInstance({ id })),
    listInstances: vi.fn(async (): Promise<Instance[]> => [fakeInstance()]),
    waitForRunning: vi.fn(async (id: number): Promise<Instance> => fakeInstance({ id })),
    stopInstance: vi.fn(async () => undefined),
    startInstance: vi.fn(async () => undefined),
    destroyInstance: vi.fn(async () => undefined),
    sshUrl: vi.fn(async (): Promise<{ host: string; port: number } | null> => ({
      host: "1.2.3.4",
      port: 12345,
    })),
    createSshKey: vi.fn(async (): Promise<{ id: number }> => ({ id: 999 })),
    deleteSshKey: vi.fn(async () => undefined),
    attachSshKey: vi.fn(async () => undefined),
    listSshKeys: vi.fn(async (): Promise<Array<{ id: number; public_key: string }>> => []),
    instanceLogs: vi.fn(async (): Promise<string> => ""),
  };
  const client = { ...mocks, ...overrides } as VastClient & {
    mocks: typeof mocks;
  };
  client.mocks = mocks;
  return client;
}

/** A mock container exec that simulates the SSH key flow + tunnel probes. */
export function mockExec(): ContainerExec & {
  responses: Record<string, string>;
  setFile: (path: string, exists: boolean) => void;
  setTunnelAlive: (alive: boolean) => void;
} {
  const files = new Map<string, boolean>();
  let tunnelAlive = true;
  const responses: Record<string, string> = {
    "/app/gpu/onstart.sh": "#!/bin/bash\nexit 0\n",
    "/app/gpu/onstart-baked.sh": "#!/bin/bash\nexit 0\n",
  };
  const fn = vi.fn(async (_row: ContainerRow, cmd: string[]) => {
    const bashCmd = cmd[0] === "bash" && cmd[1] === "-lc" ? cmd[2] : "";
    if (bashCmd.includes("test -f /workspace/.ssh/gpu_ed25519")) {
      return files.get("/workspace/.ssh/gpu_ed25519")
        ? { code: 0, stdout: "exists\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" };
    }
    if (bashCmd.includes("ssh-keygen") && bashCmd.includes("gpu_ed25519")) {
      files.set("/workspace/.ssh/gpu_ed25519", true);
      return { code: 0, stdout: "generated\n", stderr: "" };
    }
    if (bashCmd.includes("cat /workspace/.ssh/gpu_ed25519.pub")) {
      return { code: 0, stdout: "ssh-ed25519 AAAAC3test mock-key-for-tests\n", stderr: "" };
    }
    if (bashCmd.includes("echo ssh_ready")) {
      return { code: 0, stdout: "ssh_ready\n", stderr: "" };
    }
    if (bashCmd.includes("blender-mcp-ready")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    // autossh tunnel start (startTunnel) — mock success.
    if (bashCmd.includes("autossh")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    // pkill of autossh/ssh tunnel (stopTunnel) — mock success.
    if (bashCmd.includes("pkill")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    // nc probe of the local tunnel — respects setTunnelAlive().
    if (bashCmd.includes("nc -z 127.0.0.1")) {
      return tunnelAlive
        ? { code: 0, stdout: "ok\n", stderr: "" }
        : { code: 1, stdout: "dead\n", stderr: "" };
    }
    if (cmd[0] === "bash") return { code: 0, stdout: "", stderr: "" };
    if (cmd[0] === "cat" && cmd[1]) {
      return { code: 0, stdout: responses[cmd[1]] ?? "", stderr: "" };
    }
    if (cmd[0] === "test" && cmd[1] === "-f" && cmd[2]) {
      return { code: files.get(cmd[2]) ? 0 : 1, stdout: "", stderr: "" };
    }
    if (cmd[0] === "mkdir") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }) as unknown as ContainerExec;
  return Object.assign(fn, {
    responses,
    setFile: (path: string, exists: boolean) => files.set(path, exists),
    setTunnelAlive: (alive: boolean) => { tunnelAlive = alive; },
  });
}

export function mockFileOps(): InstanceFileOps {
  return {
    scpToInstance: vi.fn(async () => undefined),
    scpFromInstance: vi.fn(async () => undefined),
  };
}

// ── DB seeding ──────────────────────────────────────────────────────────────

const DEFAULT_USER: UserRow = {
  id: 1,
  username: "test",
  password_hash: "x",
  is_admin: 0,
  created_at: 0,
} as unknown as UserRow;

const DEFAULT_CONTAINER: ContainerRow = fakeContainer();

/**
 * Wipe and reseed the minimal rows the lease routes need:
 *   - user 1
 *   - a ready container for user 1
 *   - one or more blender workflow_instances
 *
 * Pass `lanes` to seed multiple lanes (for tests 4/5/6). Each lane gets a
 * distinct instance id and folder.
 */
export function seedForTest(
  lanes: Array<{ id: string; title?: string }> = [{ id: "inst-1" }],
): void {
  db().prepare("DELETE FROM gpu_leases").run();
  db().prepare("DELETE FROM workflow_instances").run();
  db().prepare("DELETE FROM containers").run();
  db().prepare("DELETE FROM users").run();

  db()
    .prepare(
      "INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(DEFAULT_USER.id, DEFAULT_USER.username, DEFAULT_USER.password_hash, 0, 0);

  db()
    .prepare(
      "INSERT INTO containers (user_id, project_name, opencode_port, oauth_port, relay_port, container_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      DEFAULT_CONTAINER.user_id,
      DEFAULT_CONTAINER.project_name,
      DEFAULT_CONTAINER.opencode_port,
      DEFAULT_CONTAINER.oauth_port,
      DEFAULT_CONTAINER.relay_port,
      DEFAULT_CONTAINER.container_id,
      "ready",
      0,
    );

  for (const lane of lanes) {
    db()
      .prepare(
        "INSERT INTO workflow_instances (id, user_id, workflow_type, title, folder) VALUES (?, ?, 'blender', ?, ?)",
      )
      .run(
        lane.id,
        DEFAULT_USER.id,
        lane.title ?? "Test",
        `/workspace/blends/${lane.id}`,
      );
  }
}

/** The seeded user the routes will authenticate as (via the auth mock). */
export function testUser(): UserRow {
  return DEFAULT_USER;
}

// ── Lease-manager bootstrap ─────────────────────────────────────────────────

export interface BootedManager {
  manager: LeaseManager;
  vast: ReturnType<typeof mockVast>;
  exec: ReturnType<typeof mockExec>;
  stop: () => void;
}

/**
 * Build a real lease manager (real DB, real background loops) with mocked
 * vast/exec/fileOps, install it via the test seam so route handlers reach it,
 * and return spies the test can assert on. `start` defaults to true so the
 * watchdog/reaper/sync/queue loops run (needed for tests 2/3/6); pass
 * { start: false } to drive methods directly.
 *
 * IMPORTANT: the caller MUST call `stop()` (or use the afterEach hook this
 * helper registers) to clear the singleton + stop background loops, otherwise
 * the mock leaks into the next test file.
 */
export function bootTestLeaseManager(opts: {
  vast?: ReturnType<typeof mockVast>;
  exec?: ReturnType<typeof mockExec>;
  fileOps?: InstanceFileOps;
  maxConcurrent?: number;
  idleTimeoutMs?: number;
  watchdogIntervalMs?: number;
  start?: boolean;
} = {}): BootedManager {
  const vast = opts.vast ?? mockVast();
  const exec = opts.exec ?? mockExec();
  const fileOps = opts.fileOps ?? mockFileOps();
  const manager = createLeaseManager({
    vast,
    exec,
    fileOps,
    maxConcurrent: opts.maxConcurrent,
    idleTimeoutMs: opts.idleTimeoutMs,
    watchdogIntervalMs: opts.watchdogIntervalMs,
  });
  if (opts.start !== false) manager.start();
  _setLeaseManagerForTests(manager);

  return {
    manager,
    vast,
    exec,
    stop: () => {
      manager.stop();
      _clearLeaseManagerForTests();
    },
  };
}

// ── Route-handler invocation ────────────────────────────────────────────────

/**
 * Install a vi.mock for `@/lib/auth` so `currentUser()` returns `user` for the
 * duration of this test file. Must be called at module top-level (before any
 * import that transitively pulls in the route handlers) because vi.mock is
 * hoisted. Returns nothing — the mock is global to the file.
 *
 * Usage:
 *   mockCurrentUser(() => testUser());
 *   import { POST } from "@/app/api/.../route";
 *
 * The lazy functional form lets each test override the user (e.g. to simulate
 * "no session" -> 401) by re-pointing the closure.
 */
let _currentUser: (() => UserRow | null) | null = null;
export function setCurrentUserForTests(fn: () => UserRow | null): void {
  _currentUser = fn;
}
export function __currentUserForTests(): UserRow | null {
  return _currentUser ? _currentUser() : null;
}

/**
 * Call a lease route handler (GET/POST/DELETE) in-process. Builds the Request
 * and params, dispatches, and returns the parsed JSON + status.
 *
 * The auth mock must already be installed (via mockCurrentUser at the top of
 * the test file). Pass `body` for POST; it's JSON-encoded.
 */
export async function callLeaseApi(
  method: "GET" | "POST" | "DELETE",
  handler: (req: Request, ctx: { params: Promise<{ instanceId: string }> }) => Promise<Response>,
  instanceId: string,
  opts: { body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const url = `http://localhost/api/workspace/${instanceId}/blender/lease`;
  const init: RequestInit = { method };
  if (method === "POST") {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body ?? {});
  }
  const req = new Request(url, init);
  const ctx = { params: Promise.resolve({ instanceId }) };
  const res = await handler(req, ctx);
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}
