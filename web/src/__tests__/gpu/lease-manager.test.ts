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

describe("lease manager: Sketchfab API key plumbing", () => {
  it("passes BLENDERMCP_SKETCHFAB_API_KEY to createInstance when SKETCHFAB_API_KEY is set", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({ vast, exec: mockExec(), fileOps: mockFileOps() });
    const saved = process.env.SKETCHFAB_API_KEY;
    process.env.SKETCHFAB_API_KEY = "tok_123";

    try {
      await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });
      const call = vast.mocks.createInstance.mock.calls[0][0] as { env?: Record<string, string> };
      // Renamed at pass-through so the addon's expected env var reaches the GPU.
      expect(call.env).toMatchObject({
        BLENDERMCP_SKETCHFAB_API_KEY: "tok_123",
        GPU_SSH_PUBKEY: expect.any(String),
      });
    } finally {
      if (saved === undefined) delete process.env.SKETCHFAB_API_KEY;
      else process.env.SKETCHFAB_API_KEY = saved;
    }
  });

  it("omits the Sketchfab var entirely when SKETCHFAB_API_KEY is unset", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({ vast, exec: mockExec(), fileOps: mockFileOps() });
    const saved = process.env.SKETCHFAB_API_KEY;
    delete process.env.SKETCHFAB_API_KEY;

    try {
      await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });
      const call = vast.mocks.createInstance.mock.calls[0][0] as { env?: Record<string, string> };
      expect(call.env).toHaveProperty("GPU_SSH_PUBKEY");
      expect(call.env).not.toHaveProperty("BLENDERMCP_SKETCHFAB_API_KEY");
    } finally {
      if (saved === undefined) delete process.env.SKETCHFAB_API_KEY;
      else process.env.SKETCHFAB_API_KEY = saved;
    }
  });

  it("re-asserts the sketchfab checkbox (alongside polyhaven) on resume", async () => {
    // The prop is serialized into scene.blend; a resumed pre-fix blend carries
    // False. The resume re-assert sets both polyhaven AND sketchfab checkboxes
    // over the socket, so the agent's sketchfab tools work after a resume.
    const vast = mockVast();
    const exec = mockExec();
    const mgr = createLeaseManager({ vast, exec, fileOps: mockFileOps() });
    // A resume .blend exists so the full resume path (push + re-assert) runs.
    exec.setFile("/workspace/blends/inst-1/scene.blend", true);

    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: true });

    const calls = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const reassert = calls.find((c: unknown[]) => {
      const cmd = c[1] as string[];
      return (
        cmd[0] === "bash" &&
        cmd[2]?.includes("blendermcp_use_polyhaven") &&
        cmd[2]?.includes("blendermcp_use_sketchfab")
      );
    });
    expect(reassert).toBeDefined();
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
      // Look for an actual file-push command (scp/cp/cat) that references the
      // .blend path. Exclude the polyhaven/sketchfab re-assert save command
      // (which mentions scene.blend in bpy.ops.wm.save_as_mainfile but is a
      // Blender socket save, not a file push).
      return (
        cmd[0] === "bash" &&
        cmd[2]?.includes("scene.blend") &&
        cmd[2]?.includes("/root/blender/") &&
        !cmd[2]?.includes("blendermcp_use_")
      );
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

// ── New behavior: manually_released flag + release state machine ───────────

/** Insert a lease row directly (used to script watchdog scenarios). */
function seedLease(over: Partial<{
  instance_id: string;
  user_id: number;
  state: string;
  vast_id: number;
  ssh_host: string;
  ssh_port: number;
  last_activity: number;
  acquired_at: number;
  manually_released: number;
}> = {}): void {
  db()
    .prepare(
      `INSERT INTO gpu_leases
         (instance_id, user_id, state, vast_id, gpu_name, dph, ssh_host, ssh_port,
          ssh_key_id, queue_position, queue_requested_at, acquired_at, last_activity,
          last_synced_at, last_error, manually_released)
       VALUES (@instance_id, @user_id, @state, @vast_id, 'RTX 4060', 0.07, @ssh_host, @ssh_port,
          NULL, NULL, NULL, @acquired_at, @last_activity, NULL, NULL, @manually_released)`,
    )
    .run({
      instance_id: "inst-1",
      user_id: 1,
      state: "ready",
      vast_id: 500,
      ssh_host: "1.2.3.4",
      ssh_port: 12345,
      last_activity: Date.now(),
      acquired_at: Date.now(),
      manually_released: 0,
      ...over,
    });
}

describe("lease manager: manual release state machine", () => {
  it("release('manual') writes `releasing` synchronously, then `destroyed` after the background destroy", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({ vast, exec: mockExec(), fileOps: mockFileOps() });
    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });

    const t0 = Date.now();
    await mgr.release("inst-1", "manual");
    const elapsed = Date.now() - t0;
    // The DELETE returns immediately — heavy work (sync/destroy) is backgrounded.
    expect(elapsed).toBeLessThan(500);

    // SYNCHRONOUS transitional state (the whole point): the row is `releasing`
    // + manually_released=1 so concurrent readers (UI poll, AI prefill) see
    // "release in progress" the instant the lock is acquired. ssh/vast fields
    // are RETAINED so the background sync can still reach the instance.
    const row = mgr.get("inst-1");
    expect(row).not.toBeNull();
    expect(row!.state).toBe("releasing");
    expect(row!.manually_released).toBe(1);
    expect(row!.ssh_host).toBe("1.2.3.4");
    expect(row!.ssh_port).toBe(12345);
    expect(row!.vast_id).toBe(500);

    // The instance is destroyed on the background promise; let it flush.
    await new Promise((r) => setTimeout(r, 50));
    expect(vast.mocks.destroyInstance).toHaveBeenCalledWith(500);

    // After the background destroy completes, the row reaches the terminal
    // `destroyed` state with all instance fields nulled.
    const finalRow = mgr.get("inst-1");
    expect(finalRow).not.toBeNull();
    expect(finalRow!.state).toBe("destroyed");
    expect(finalRow!.manually_released).toBe(1);
    expect(finalRow!.ssh_host).toBeNull();
    expect(finalRow!.ssh_port).toBeNull();
    expect(finalRow!.vast_id).toBeNull();
  });

  it("does NOT clobber a re-acquired lease when the background destroy finishes (state=releasing guard)", async () => {
    const vast = mockVast();
    const exec = mockExec();
    const mgr = createLeaseManager({ vast, exec, fileOps: mockFileOps() });
    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });

    // Kick off a manual release (enters `releasing`, starts background destroy).
    mgr.release("inst-1", "manual");
    // While the background destroy is still resolving, re-acquire: this resets
    // the row out of `releasing` (to provisioning→ready) and provisions a new
    // instance. The background closure must NOT then stomp that fresh lease.
    const lease = await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });

    // Let any background release work finish.
    await new Promise((r) => setTimeout(r, 50));

    // The re-acquire won; the row is ready (not destroyed) and the flag cleared.
    expect(lease.state).toBe("ready");
    expect(lease.manually_released).toBe(0);
    const after = mgr.get("inst-1");
    expect(after?.state).toBe("ready");
    expect(after?.manually_released).toBe(0);
  });

  it("release('idle-timeout') deletes the row (next view auto-acquires)", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({ vast, exec: mockExec(), fileOps: mockFileOps() });
    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });

    await mgr.release("inst-1", "idle-timeout");

    // Non-manual release deletes the row — no manual flag, no auto-acquire suppression.
    expect(mgr.get("inst-1")).toBeNull();
    expect(vast.mocks.destroyInstance).toHaveBeenCalledWith(500);
  });

  it("acquire on a destroyed+flagged row clears the flag and reprovisions", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({ vast, exec: mockExec(), fileOps: mockFileOps() });
    // Acquire → release manually → row is destroyed+flagged.
    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });
    await mgr.release("inst-1", "manual");
    expect(vast.mocks.createInstance).toHaveBeenCalledOnce();

    // Explicit re-acquire (the "Acquire GPU" button): should provision a NEW instance.
    const lease = await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: true });

    expect(lease.state).toBe("ready");
    expect(lease.manually_released).toBe(0);
    // Two creates: original + re-acquire.
    expect(vast.mocks.createInstance).toHaveBeenCalledTimes(2);
  });
});

describe("lease manager: watchdog respects manually_released", () => {
  it("does NOT re-provision a manually-released lease whose instance is gone", async () => {
    const vast = mockVast();
    vast.mocks.getInstance.mockResolvedValue(null); // instance vanished
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      watchdogIntervalMs: 20,
      idleReaperIntervalMs: 60_000,
    });
    // Seed a row that was manually released: state=destroyed, flag=1, but the
    // background destroy hasn't nulled vast_id yet (process killed mid-destroy).
    // Actually the watchdog query for liveness selects ready/provisioning/recovering,
    // so to test the reProvision guard we seed a recovering row with the flag set
    // (the realistic "flag set but not yet destroyed" race).
    seedLease({ state: "recovering", manually_released: 1, vast_id: 500 });

    mgr.start();
    await new Promise((r) => setTimeout(r, 200));
    mgr.stop();

    // A manually-released GPU must NEVER be auto-reprovisioned. No createInstance.
    expect(vast.mocks.createInstance).not.toHaveBeenCalled();
  });

  it("re-provisions an auto-acquired (non-manual) lease whose instance is gone", async () => {
    const vast = mockVast();
    vast.mocks.getInstance.mockResolvedValue(null);
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      watchdogIntervalMs: 20,
      idleReaperIntervalMs: 60_000,
    });
    seedLease({ state: "ready", manually_released: 0, vast_id: 500 });

    mgr.start();
    await new Promise((r) => setTimeout(r, 200));
    mgr.stop();

    // Crash recovery still works for non-manual leases.
    expect(vast.mocks.destroyInstance).toHaveBeenCalledWith(500);
    expect(vast.mocks.createInstance).toHaveBeenCalled();
  });
});

describe("lease manager: reProvision destroy-failure safety", () => {
  it("does NOT create a 2nd instance when destroy of the dead instance fails", async () => {
    const vast = mockVast();
    vast.mocks.getInstance.mockResolvedValue(null); // instance gone
    vast.mocks.destroyInstance.mockRejectedValue(new Error("vastai 503"));
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      watchdogIntervalMs: 20,
      idleReaperIntervalMs: 60_000,
      destroyRetries: 2,
      destroyBackoffMs: 5, // fast backoff so the test doesn't wait on the real 1.5s
    });
    seedLease({ state: "ready", manually_released: 0, vast_id: 500 });

    mgr.start();
    // Wait long enough for the retry+backoff to complete (2 attempts * 5ms + overhead).
    await new Promise((r) => setTimeout(r, 300));
    mgr.stop();
    // Drain any in-flight tick so it can't touch the next test's seeded row.
    await new Promise((r) => setTimeout(r, 30));

    // Destroy was attempted (with retries) but failed. No new instance created —
    // the re-provision was aborted to avoid orphaning a billing instance.
    expect(vast.mocks.destroyInstance).toHaveBeenCalledWith(500);
    expect(vast.mocks.createInstance).not.toHaveBeenCalled();
    // Lease is left recovering with an error so the next tick retries.
    const row = mgr.get("inst-1");
    expect(row?.state).toBe("recovering");
    expect(row?.last_error).toMatch(/destroy of dead instance 500 failed/);
  });
});

describe("lease manager: reapReleases finalizes stranded rows", () => {
  it("reaps a 'releasing' row older than the stale threshold", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      watchdogIntervalMs: 20,
      idleReaperIntervalMs: 60_000,
      destroyRetries: 1,
    });
    // Seed a 'releasing' row with last_activity 120s ago (beyond the 90s threshold).
    seedLease({
      state: "releasing",
      vast_id: 500,
      last_activity: Date.now() - 120_000,
    });

    mgr.start();
    await new Promise((r) => setTimeout(r, 200));
    mgr.stop();
    // Let any in-flight tick from this manager finish before asserting, so it
    // can't race the next test's seeded row (tests share the DB file).
    await new Promise((r) => setTimeout(r, 30));

    // Stranded row reaped: instance destroyed, row deleted (non-manual path).
    expect(vast.mocks.destroyInstance).toHaveBeenCalledWith(500);
    expect(mgr.get("inst-1")).toBeNull();
  });

  it("reaps a STRANDED MANUAL 'releasing' row to destroyed (not deleted) so the lane doesn't auto-reacquire", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      watchdogIntervalMs: 20,
      idleReaperIntervalMs: 60_000,
      destroyRetries: 1,
    });
    // A manual release was in progress (releasing + manually_released=1) when the
    // process was killed, stranding the row past STALE_RELEASING_MS.
    seedLease({
      state: "releasing",
      manually_released: 1,
      vast_id: 500,
      last_activity: Date.now() - 120_000,
    });

    mgr.start();
    await new Promise((r) => setTimeout(r, 200));
    mgr.stop();
    await new Promise((r) => setTimeout(r, 30));

    // Instance destroyed, and the row finalizes to `destroyed` (NOT deleted) so
    // a lane remount does NOT silently auto-reacquire a GPU the user released.
    expect(vast.mocks.destroyInstance).toHaveBeenCalledWith(500);
    const row = mgr.get("inst-1");
    expect(row).not.toBeNull();
    expect(row!.state).toBe("destroyed");
    expect(row!.manually_released).toBe(1);
    expect(row!.vast_id).toBeNull();
  });

  it("finalizes a 'destroyed' row whose vast_id wasn't nulled (unfinished destroy)", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      watchdogIntervalMs: 20,
      idleReaperIntervalMs: 60_000,
      destroyRetries: 1,
    });
    // A manual release marked the row destroyed but the background destroy was
    // killed before nulling vast_id.
    seedLease({ state: "destroyed", manually_released: 1, vast_id: 500 });

    mgr.start();
    await new Promise((r) => setTimeout(r, 200));
    mgr.stop();

    expect(vast.mocks.destroyInstance).toHaveBeenCalledWith(500);
    const row = mgr.get("inst-1");
    expect(row).not.toBeNull();
    expect(row!.state).toBe("destroyed");
    expect(row!.vast_id).toBeNull(); // finalized
  });
});

describe("lease manager: atomic concurrency reservation", () => {
  it("respects maxConcurrent across concurrent acquires (no TOCTOU overrun)", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      maxConcurrent: 1,
    });
    db().prepare(
      "INSERT INTO workflow_instances (id, user_id, workflow_type, title, folder) VALUES ('inst-2', 1, 'blender', 'T2', '/workspace/blends/inst-2')",
    ).run();

    // Fire both concurrently. acquireImpl yields at `await provisionInstance`, so
    // the second call runs its claimConcurrencySlot transaction while the first
    // is still mid-provision. The atomic reservation must see the first's row and
    // queue the second (the old read-then-insert code could create two instances).
    await Promise.all([
      mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false }),
      mgr.acquire({ instanceId: "inst-2", userId: 1, container: fakeContainer(), resume: false }),
    ]);

    // Exactly one provisioned; the other queued. (Old code could create two.)
    const created = (vast.mocks.createInstance as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(created).toBe(1);
    const states = [mgr.get("inst-1")?.state, mgr.get("inst-2")?.state].sort();
    expect(states).toEqual(["queued", "ready"]);
  });
});

