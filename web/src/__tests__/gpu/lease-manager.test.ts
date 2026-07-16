/**
 * Unit tests for the GPU Lease Manager (lib/gpu/lease-manager.ts).
 *
 * The lease manager is fully injectable: the vast client, container-exec, and
 * file ops are all mocked, so these tests run without real GPU instances or
 * containers. The DB uses a real better-sqlite3 against a temp file (the
 * schema is tiny and synchronous, simpler than mocking).
 *
 * Each test gets a fresh DB + fresh lease manager. Background loops are NOT
 * started (we call the public methods directly); watchdog/sync/queue/idle
 * behavior is tested by invoking the manager's methods with scripted state.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Point DB_PATH at a temp file BEFORE importing db.ts. The _resetDbForTests
// call in beforeAll guarantees a fresh connection even if db.ts was already
// cached by another test file in the same vitest worker.
const tmpDir = mkdtempSync(resolve(tmpdir(), "aios-lease-test-"));
process.env.DB_PATH = resolve(tmpDir, "test.db");
// Force the default CUDA image for tests — .env may have a custom GPU_IMAGE
// (e.g. walkerp07/blender-mcp:latest) which would change onstart script paths.
delete process.env.GPU_IMAGE;

import { db, _resetDbForTests } from "@/lib/db";
import { createLeaseManager, type ContainerExec, type InstanceFileOps } from "@/lib/gpu/lease-manager";
import type { VastClient } from "@/lib/gpu/vast";
import type { Offer, Instance } from "@/lib/gpu/types";
import type { ContainerRow } from "@/lib/db";

// ── Fixtures ────────────────────────────────────────────────────────────────

function fakeOffer(over: Partial<Offer> = {}): Offer {
  return {
    id: 100,
    gpu_name: "RTX 4060",
    num_gpus: 1,
    dph_total: 0.07,
    dlperf: 50,
    dlperf_per_dphtotal: 700,
    cuda_max_good: 12.4,
    rentable: true,
    ...over,
  };
}

function fakeInstance(over: Partial<Instance> = {}): Instance {
  return { id: 500, cur_state: "running", gpu_name: "RTX 4060", dph_total: 0.07, ...over };
}

function fakeContainer(): ContainerRow {
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

/** A mock vast client with vi.fn spies for every method. */
function mockVast(overrides: Partial<VastClient> = {}): VastClient & {
  mocks: Record<string, ReturnType<typeof vi.fn>>;
} {
  const mocks = {
    showUser: vi.fn(async () => ({})),
    searchOffers: vi.fn(async (): Promise<Offer[]> => [fakeOffer()]),
    createInstance: vi.fn(async (): Promise<{ id: number }> => ({ id: 500 })),
    getInstance: vi.fn(async (): Promise<Instance | null> => fakeInstance()),
    listInstances: vi.fn(async (): Promise<Instance[]> => [fakeInstance()]),
    waitForRunning: vi.fn(async (): Promise<Instance> => fakeInstance()),
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
  };
  const client = { ...mocks, ...overrides } as VastClient & {
    mocks: typeof mocks;
  };
  client.mocks = mocks;
  return client;
}

/** A mock container exec that simulates the SSH key flow + tunnel probes. */
function mockExec(): ContainerExec & { responses: Record<string, string>; setFile: (path: string, exists: boolean) => void } {
  const files = new Map<string, boolean>();
  const responses: Record<string, string> = {
    "/app/gpu/onstart.sh": "#!/bin/bash\nexit 0\n",
    "/app/gpu/onstart-baked.sh": "#!/bin/bash\nexit 0\n",
  };
  const fn = vi.fn(async (_row: ContainerRow, cmd: string[]) => {
    const bashCmd = cmd[0] === "bash" && cmd[1] === "-lc" ? cmd[2] : "";
    // SSH key check: `test -f /workspace/.ssh/gpu_ed25519 && echo exists`
    if (bashCmd.includes("test -f /workspace/.ssh/gpu_ed25519")) {
      return files.get("/workspace/.ssh/gpu_ed25519")
        ? { code: 0, stdout: "exists\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" };
    }
    // SSH key generation
    if (bashCmd.includes("ssh-keygen") && bashCmd.includes("gpu_ed25519")) {
      files.set("/workspace/.ssh/gpu_ed25519", true);
      return { code: 0, stdout: "generated\n", stderr: "" };
    }
    // Read SSH public key
    if (bashCmd.includes("cat /workspace/.ssh/gpu_ed25519.pub")) {
      return { code: 0, stdout: "ssh-ed25519 AAAAC3test mock-key-for-tests\n", stderr: "" };
    }
    // SSH readiness probe
    if (bashCmd.includes("echo ssh_ready")) {
      return { code: 0, stdout: "ssh_ready\n", stderr: "" };
    }
    // Blender socket sentinel probe
    if (bashCmd.includes("blender-mcp-ready")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    // nc probe of the local tunnel
    if (bashCmd.includes("nc -z 127.0.0.1")) {
      return { code: 0, stdout: "ok\n", stderr: "" };
    }
    // All other bash commands (scp, ssh mkdir, tunnel start, etc.) succeed.
    if (cmd[0] === "bash") return { code: 0, stdout: "", stderr: "" };
    // Handle `cat <path>` for onstart script.
    if (cmd[0] === "cat" && cmd[1]) {
      return { code: 0, stdout: responses[cmd[1]] ?? "", stderr: "" };
    }
    // Handle `test -f <path>` for .blend resume check.
    if (cmd[0] === "test" && cmd[1] === "-f" && cmd[2]) {
      return { code: files.get(cmd[2]) ? 0 : 1, stdout: "", stderr: "" };
    }
    // Handle `mkdir -p`.
    if (cmd[0] === "mkdir") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }) as unknown as ContainerExec;
  return Object.assign(fn, {
    responses,
    setFile: (path: string, exists: boolean) => files.set(path, exists),
  });
}

function mockFileOps(): InstanceFileOps {
  return {
    scpToInstance: vi.fn(async () => undefined),
    scpFromInstance: vi.fn(async () => undefined),
  };
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeAll(() => {
  // Force a fresh DB connection against the temp file, even if db.ts was
  // already cached by another test file in this vitest worker. Without this,
  // the singleton would still point at the production DB.
  _resetDbForTests();
  db(); // initialize schema
});

beforeEach(() => {
  // Clear all rows so each test starts from a clean slate. Keep the schema.
  db().prepare("DELETE FROM gpu_leases").run();
  db().prepare("DELETE FROM workflow_instances").run();
  db().prepare("DELETE FROM containers").run();
  db().prepare("DELETE FROM users").run();
  // Seed a user so FKs resolve.
  db().prepare(
    "INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'test', 'x', 0, 0)",
  ).run();
  // Seed a container row.
  db().prepare(
    "INSERT INTO containers (user_id, project_name, opencode_port, oauth_port, relay_port, container_id, status, created_at) VALUES (1, 'aios-test', 4100, 19800, 19801, 'abc', 'ready', 0)",
  ).run();
  // Seed a workflow instance (the Blender lane).
  db().prepare(
    "INSERT INTO workflow_instances (id, user_id, workflow_type, title, folder) VALUES ('inst-1', 1, 'blender', 'Test', '/workspace/blends/inst-1')",
  ).run();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("lease manager: acquire", () => {
  it("provisions an instance and reaches ready when capacity allows", async () => {
    const vast = mockVast();
    const exec = mockExec();
    const mgr = createLeaseManager({ vast, exec, fileOps: mockFileOps() });

    const lease = await mgr.acquire({
      instanceId: "inst-1",
      userId: 1,
      container: fakeContainer(),
      resume: false,
    });

    expect(lease.state).toBe("ready");
    expect(lease.vast_id).toBe(500);
    expect(lease.gpu_name).toBe("RTX 4060");
    expect(lease.ssh_host).toBe("1.2.3.4");
    expect(vast.mocks.createInstance).toHaveBeenCalledOnce();
    expect(vast.mocks.waitForRunning).toHaveBeenCalledWith(500);
    expect(vast.mocks.destroyInstance).not.toHaveBeenCalled();
  });

  it("is idempotent — a second acquire returns the existing lease", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({ vast, exec: mockExec(), fileOps: mockFileOps() });
    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });
    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });
    expect(vast.mocks.createInstance).toHaveBeenCalledOnce();
  });

  it("queues when at concurrency capacity", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      maxConcurrent: 1,
    });
    // First acquire fills the single slot.
    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });
    // Seed a second instance for a different lane.
    db().prepare(
      "INSERT INTO workflow_instances (id, user_id, workflow_type, title, folder) VALUES ('inst-2', 1, 'blender', 'Test 2', '/workspace/blends/inst-2')",
    ).run();

    const lease2 = await mgr.acquire({ instanceId: "inst-2", userId: 1, container: fakeContainer(), resume: false });
    expect(lease2.state).toBe("queued");
    expect(lease2.queue_position).toBe(0);
    // Only one instance was created.
    expect(vast.mocks.createInstance).toHaveBeenCalledOnce();
  });
});

describe("lease manager: release", () => {
  it("destroys the instance even if sync throws (storage fees never accrue)", async () => {
    const vast = mockVast();
    const fileOps = mockFileOps();
    // Make syncDown fail.
    (fileOps.scpFromInstance as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("scp failed"));
    const mgr = createLeaseManager({ vast, exec: mockExec(), fileOps });

    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });
    await mgr.release("inst-1", "test");

    // CRITICAL: destroy MUST have been called despite the sync failure.
    expect(vast.mocks.destroyInstance).toHaveBeenCalledWith(500);
    // And the lease row is gone.
    expect(mgr.get("inst-1")).toBeNull();
  });

  it("release is a no-op when no lease exists", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({ vast, exec: mockExec(), fileOps: mockFileOps() });
    await mgr.release("nope");
    expect(vast.mocks.destroyInstance).not.toHaveBeenCalled();
  });
});

describe("lease manager: touch + idle", () => {
  it("touch bumps last_activity", async () => {
    const mgr = createLeaseManager({
      vast: mockVast(),
      exec: mockExec(),
      fileOps: mockFileOps(),
      idleTimeoutMs: 1000,
    });
    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });
    const before = mgr.get("inst-1")!.last_activity;
    await new Promise((r) => setTimeout(r, 20));
    mgr.touch("inst-1");
    const after = mgr.get("inst-1")!.last_activity;
    expect(after).toBeGreaterThan(before);
  });

  it("releases idle leases after the timeout", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      idleTimeoutMs: 50, // very short for the test
      idleReaperIntervalMs: 30, // poll fast
    });
    mgr.start();
    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });
    // Don't touch — let it go idle.
    await new Promise((r) => setTimeout(r, 300));
    mgr.stop();
    expect(vast.mocks.destroyInstance).toHaveBeenCalledWith(500);
    expect(mgr.get("inst-1")).toBeNull();
  });
});

describe("lease manager: resume", () => {
  it("pushes the saved .blend up when resuming and it exists", async () => {
    const vast = mockVast();
    const exec = mockExec();
    const mgr = createLeaseManager({ vast, exec, fileOps: mockFileOps() });

    // Simulate a pre-existing saved .blend in the workspace.
    exec.setFile("/workspace/blends/inst-1/scene.blend", true);

    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: true });

    // The provision should have scp'd the .blend to the instance. Check that an
    // exec call was made with an scp command containing the blend path.
    const calls = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const blendScp = calls.find((c: unknown[]) => {
      const cmd = c[1] as string[];
      return cmd[0] === "bash" && cmd[2]?.includes("scene.blend") && cmd[2]?.includes("/root/blender/");
    });
    expect(blendScp).toBeDefined();
  });

  it("does NOT push a .blend when resume but none exists", async () => {
    const vast = mockVast();
    const exec = mockExec();
    const mgr = createLeaseManager({ vast, exec, fileOps: mockFileOps() });

    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: true });

    const calls = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const blendScp = calls.find((c: unknown[]) => {
      const cmd = c[1] as string[];
      return cmd[0] === "bash" && cmd[2]?.includes("scene.blend") && cmd[2]?.includes("/root/blender/");
    });
    expect(blendScp).toBeUndefined();
  });
});

describe("lease manager: liveness watchdog recovery", () => {
  it("resumes a PAUSED instance via startInstance (not re-provision)", async () => {
    const vast = mockVast();
    // First getInstance returns paused (stopped, data preserved); after start,
    // returns running.
    let state: Instance["cur_state"] = "paused";
    vast.mocks.getInstance.mockImplementation(async () => fakeInstance({ cur_state: state }));
    vast.mocks.startInstance.mockImplementation(async () => {
      state = "running";
    });

    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      watchdogIntervalMs: 20,
      idleReaperIntervalMs: 60_000, // don't interfere with this test
    });
    mgr.start();
    // Manually insert a ready lease to simulate a lease that went paused.
    db().prepare(
      `INSERT INTO gpu_leases (instance_id, user_id, state, vast_id, gpu_name, dph, ssh_host, ssh_port, last_activity, acquired_at)
       VALUES ('inst-1', 1, 'ready', 500, 'RTX 4060', 0.07, '1.2.3.4', 12345, ?, ?)`,
    ).run(Date.now(), Date.now());

    // Run the watchdog tick path by waiting for the interval.
    await new Promise((r) => setTimeout(r, 200));
    mgr.stop();

    // startInstance was called (resume the paused instance), NOT createInstance
    // (no re-provision).
    expect(vast.mocks.startInstance).toHaveBeenCalledWith(500);
    expect(vast.mocks.createInstance).not.toHaveBeenCalled();
    expect(vast.mocks.destroyInstance).not.toHaveBeenCalled();
  });

  it("re-provisions fresh when the instance is gone (destroyed)", async () => {
    const vast = mockVast();
    vast.mocks.getInstance.mockResolvedValue(null); // instance vanished

    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      watchdogIntervalMs: 20,
      idleReaperIntervalMs: 60_000,
    });
    mgr.start();
    db().prepare(
      `INSERT INTO gpu_leases (instance_id, user_id, state, vast_id, gpu_name, dph, ssh_host, ssh_port, last_activity, acquired_at)
       VALUES ('inst-1', 1, 'ready', 500, 'RTX 4060', 0.07, '1.2.3.4', 12345, ?, ?)`,
    ).run(Date.now(), Date.now());

    await new Promise((r) => setTimeout(r, 200));
    mgr.stop();

    // The dead instance was destroyed, and a fresh one was created (re-provision).
    expect(vast.mocks.destroyInstance).toHaveBeenCalledWith(500);
    expect(vast.mocks.createInstance).toHaveBeenCalled();
  });
});

describe("lease manager: queue pump", () => {
  it("grants a queued lease when capacity frees up", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      maxConcurrent: 1,
      queuePumpIntervalMs: 50,
    });
    // Seed two instances.
    db().prepare(
      "INSERT INTO workflow_instances (id, user_id, workflow_type, title, folder) VALUES ('inst-2', 1, 'blender', 'T2', '/workspace/blends/inst-2')",
    ).run();
    // Fill the single slot.
    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });
    // Queue the second.
    const l2 = await mgr.acquire({ instanceId: "inst-2", userId: 1, container: fakeContainer(), resume: false });
    expect(l2.state).toBe("queued");

    mgr.start();
    // Release the first → the queue pump should grant the second.
    await mgr.release("inst-1");
    await new Promise((r) => setTimeout(r, 200));
    mgr.stop();

    const after = mgr.get("inst-2");
    expect(after?.state).toBe("ready");
    // Two creates total (one per instance).
    expect(vast.mocks.createInstance).toHaveBeenCalledTimes(2);
  });
});
