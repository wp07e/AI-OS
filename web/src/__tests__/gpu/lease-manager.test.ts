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
    machine_id: 7000,
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
    rebootInstance: vi.fn(async () => undefined),
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
function mockExec(): ContainerExec & { responses: Record<string, string>; setFile: (path: string, exists: boolean) => void; setTunnelAlive: (alive: boolean) => void } {
  const files = new Map<string, boolean>();
  let tunnelAlive = true;
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
    // autossh tunnel start (startTunnel) — mock success.
    if (bashCmd.includes("autossh")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    // pkill of autossh/ssh tunnel (stopTunnel) — mock success.
    // NOTE: must come before the ssh-root@ branch below because the SSH probe
    // commands for restartBlender also contain "pkill -f blender".
    if (bashCmd.includes("pkill") && !bashCmd.includes("root@")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    // restartBlender SSH commands: sentinel removal, pkill blender, relaunch,
    // and the on-instance Python socket probe. The on-instance probe always
    // succeeds after relaunch — it runs directly on the GPU instance (not
    // through the tunnel), so tunnelAlive (which models the tunnel state)
    // doesn't apply here. The restart itself makes Blender come back.
    // MUST come before the get_scene_info check below so the on-instance SSH
    // probe isn't swallowed by the tunnel-state-aware probe.
    if (bashCmd.includes("ssh ") && bashCmd.includes("root@")) {
      if (bashCmd.includes("get_scene_info") || bashCmd.includes("touch /root/.blender-mcp-ready")) {
        return { code: 0, stdout: "ok\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    // Tunnel liveness probe. Two forms:
    //  - Legacy: /dev/tcp (bash builtin). Respects setTunnelAlive().
    //  - Current: Python socket protocol probe (sends get_scene_info through
    //    the tunnel, checks for a response). Respects setTunnelAlive().
    if (bashCmd.includes("/dev/tcp/127.0.0.1") || bashCmd.includes("get_scene_info")) {
      return tunnelAlive
        ? { code: 0, stdout: "ok\n", stderr: "" }
        : { code: 1, stdout: "dead\n", stderr: "" };
    }
    // All other bash commands (scp, ssh mkdir, etc.) succeed.
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
    setTunnelAlive: (alive: boolean) => { tunnelAlive = alive; },
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
  db().prepare("DELETE FROM gpu_machine_health").run();
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

// ── Queue pump diagnostics + timeout (issue: "stuck on Waiting for GPU") ────
//
// The queue pump used to swallow searchOffer errors via .catch(() => []),
// making a broken vastai CLI / bad key / rate limit indistinguishable from a
// genuinely empty market — and retrying invisibly forever with no UI signal.
// These tests pin the new behavior: the pump records what happened on each
// tick (last_checked_at + search_error), gives up after queueTimeoutMs, and
// exposes retryQueued for the "Retry now" button.

describe("lease manager: queue pump diagnostics", () => {
  it("records queue_search_error when searchOffers throws (broken CLI/auth)", async () => {
    const vast = mockVast({
      searchOffers: vi.fn(async () => {
        throw new Error("vastai: unauthorized (HTTP 401)");
      }),
    });
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      maxConcurrent: 1,
      queuePumpIntervalMs: 50,
    });
    // Seed a queued lease (skip the acquire path; we want to isolate the pump).
    seedLease({
      instance_id: "inst-1",
      state: "queued",
      queue_position: 0,
      vast_id: null,
    });

    mgr.start();
    await new Promise((r) => setTimeout(r, 120));
    mgr.stop();

    const after = mgr.get("inst-1");
    expect(after?.state).toBe("queued"); // not promoted — search failed
    expect(after?.queue_search_error).toContain("unauthorized");
    expect(after?.queue_last_checked_at).not.toBeNull();
    // last_error is NOT clobbered by a search failure (it's the *provision*
    // error channel). queue_search_error is the distinct *search* channel.
  });

  it("clears queue_search_error and stamps last_checked when the search succeeds (even if empty)", async () => {
    const vast = mockVast({
      searchOffers: vi.fn(async () => []), // genuine empty market
    });
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      maxConcurrent: 1,
      queuePumpIntervalMs: 50,
    });
    // Seed a queued lease that previously had a search error.
    seedLease({
      instance_id: "inst-1",
      state: "queued",
      queue_position: 0,
      vast_id: null,
      last_error: "no qualifying GPU offers under cap",
    });
    db()
      .prepare("UPDATE gpu_leases SET queue_search_error = ? WHERE instance_id = ?")
      .run("stale prior error", "inst-1");

    mgr.start();
    await new Promise((r) => setTimeout(r, 120));
    mgr.stop();

    const after = mgr.get("inst-1");
    expect(after?.state).toBe("queued"); // still queued — market genuinely empty
    expect(after?.queue_search_error).toBeNull(); // cleared: search succeeded
    expect(after?.queue_last_checked_at).not.toBeNull();
    expect(after?.last_error).toBe("no qualifying GPU offers under cap"); // untouched
  });
});

describe("lease manager: queue timeout", () => {
  it("transitions a queued lease to destroyed + manually_released after queueTimeoutMs", async () => {
    const vast = mockVast({
      searchOffers: vi.fn(async () => []), // never any offer
    });
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      maxConcurrent: 1,
      queuePumpIntervalMs: 40,
      queueTimeoutMs: 80, // very short for the test
    });
    // Seed a queued lease whose queue_requested_at is already past the timeout.
    seedLease({
      instance_id: "inst-1",
      state: "queued",
      queue_position: 0,
      vast_id: null,
    });
    db()
      .prepare("UPDATE gpu_leases SET queue_requested_at = ? WHERE instance_id = ?")
      .run(Date.now() - 1000, "inst-1"); // 1s ago, well past the 80ms timeout

    mgr.start();
    await new Promise((r) => setTimeout(r, 150));
    mgr.stop();

    const after = mgr.get("inst-1");
    expect(after?.state).toBe("destroyed");
    expect(after?.manually_released).toBe(1); // so auto-reacquire stays suppressed
    expect(after?.last_error).toMatch(/timed out/i);
    // The lease was NOT provisioned.
    expect(vast.mocks.createInstance).not.toHaveBeenCalled();
  });

  it("does NOT time out a recently-queued lease", async () => {
    const vast = mockVast({
      searchOffers: vi.fn(async () => []),
    });
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      queuePumpIntervalMs: 40,
      queueTimeoutMs: 5_000, // 5s — the lease (just queued) is well within
    });
    seedLease({
      instance_id: "inst-1",
      state: "queued",
      queue_position: 0,
      vast_id: null,
    });

    mgr.start();
    await new Promise((r) => setTimeout(r, 150));
    mgr.stop();

    const after = mgr.get("inst-1");
    expect(after?.state).toBe("queued"); // still trying
    expect(after?.manually_released).toBe(0);
  });
});

describe("lease manager: retryQueued", () => {
  it("forces an immediate provision attempt for a queued lease when an offer exists", async () => {
    const vast = mockVast(); // default: returns a fakeOffer
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      maxConcurrent: 1,
      // NOTE: start() NOT called — retryQueued must work without the pump loop.
    });
    seedLease({
      instance_id: "inst-1",
      state: "queued",
      queue_position: 0,
      vast_id: null,
    });

    await mgr.retryQueued("inst-1");

    const after = mgr.get("inst-1");
    expect(after?.state).toBe("ready");
    expect(vast.mocks.createInstance).toHaveBeenCalledTimes(1);
    // The diagnostic fields are stamped by the retry path too.
    expect(after?.queue_last_checked_at).not.toBeNull();
    expect(after?.queue_search_error).toBeNull();
  });

  it("is a no-op when the lease is not queued (e.g. already ready)", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({ vast, exec: mockExec(), fileOps: mockFileOps() });
    seedLease({ instance_id: "inst-1", state: "ready", vast_id: 500 });

    await mgr.retryQueued("inst-1").catch(() => {});
    // No new instance created — the ready lease is untouched.
    expect(vast.mocks.createInstance).not.toHaveBeenCalled();
  });

  it("is a no-op when no lease row exists", async () => {
    const vast = mockVast();
    const mgr = createLeaseManager({ vast, exec: mockExec(), fileOps: mockFileOps() });
    // No seed — nothing to retry.
    await mgr.retryQueued("inst-1").catch(() => {});
    expect(vast.mocks.createInstance).not.toHaveBeenCalled();
  });
});

// ── New behavior: manually_released flag + release state machine ───────────

/** Insert a lease row directly (used to script watchdog/queue scenarios). */
function seedLease(over: Partial<{
  instance_id: string;
  user_id: number;
  state: string;
  vast_id: number | null;
  ssh_host: string | null;
  ssh_port: number | null;
  last_activity: number;
  acquired_at: number;
  manually_released: number;
  releasing_since: number | null;
  queue_position: number | null;
  queue_requested_at: number | null;
  last_error: string | null;
}> = {}): void {
  db()
    .prepare(
      `INSERT INTO gpu_leases
         (instance_id, user_id, state, vast_id, gpu_name, dph, ssh_host, ssh_port,
          ssh_key_id, queue_position, queue_requested_at, queue_last_checked_at,
          queue_search_error, acquired_at, last_activity,
          last_synced_at, last_error, manually_released, releasing_since)
       VALUES (@instance_id, @user_id, @state, @vast_id, 'RTX 4060', 0.07, @ssh_host, @ssh_port,
          NULL, @queue_position, @queue_requested_at, NULL, NULL,
          @acquired_at, @last_activity, NULL, @last_error, @manually_released, @releasing_since)`,
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
      releasing_since: null,
      queue_position: null,
      queue_requested_at: null,
      last_error: null,
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

  it("reaps a stuck manual release even while the poller keeps touching last_activity (poller-defeat regression)", async () => {
    // Regression for the bug where a stuck release bills indefinitely: the
    // frontend GET /lease poller calls touch() every 5s while the lane is open,
    // which (previously) bumped last_activity on the releasing row forever,
    // defeating the reaper's last_activity-age check. The fix: (a) touch() no
    // longer refreshes releasing/destroyed rows, AND (b) a poller-independent
    // releasing_since wall-clock deadline force-reaps. This test exercises (b):
    // even with continuous touching, a release older than RELEASE_DEADLINE_MS
    // is reaped.
    const vast = mockVast();
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      watchdogIntervalMs: 20,
      idleReaperIntervalMs: 60_000,
      destroyRetries: 1,
    });
    // A manual release started 150s ago (past RELEASE_DEADLINE_MS=120s). Its
    // last_activity is FRESH (as if the poller just touched it) — this is the
    // exact defeat scenario. releasing_since is what must trigger the reap.
    seedLease({
      state: "releasing",
      manually_released: 1,
      vast_id: 500,
      last_activity: Date.now(), // fresh — poller just touched
      releasing_since: Date.now() - 150_000, // but release started 150s ago
    });

    mgr.start();
    // Continuously touch (simulate the 5s poller) during the wait window to
    // prove the reap does NOT depend on last_activity going stale.
    const poller = setInterval(() => mgr.touch("inst-1"), 25);
    await new Promise((r) => setTimeout(r, 200));
    clearInterval(poller);
    mgr.stop();
    await new Promise((r) => setTimeout(r, 30));

    // Reaped despite the fresh last_activity, because releasing_since > deadline.
    expect(vast.mocks.destroyInstance).toHaveBeenCalledWith(500);
    const row = mgr.get("inst-1");
    expect(row).not.toBeNull();
    expect(row!.state).toBe("destroyed");
    expect(row!.manually_released).toBe(1);
    expect(row!.releasing_since).toBeNull(); // cleared on finalize
  });

  it("does NOT update last_activity when touching a releasing/destroyed lease", async () => {
    // Guards the touch() gate: touch() must not refresh releasing/destroyed rows,
    // or the last_activity-based reaper path is defeated by the GET poller.
    const vast = mockVast();
    const mgr = createLeaseManager({
      vast,
      exec: mockExec(),
      fileOps: mockFileOps(),
      watchdogIntervalMs: 60_000, // don't let the watchdog reap mid-test
      idleReaperIntervalMs: 60_000,
    });
    const staleActivity = Date.now() - 5_000;
    seedLease({ state: "releasing", manually_released: 1, last_activity: staleActivity });

    mgr.touch("inst-1");
    // last_activity unchanged on a releasing row.
    expect(mgr.get("inst-1")!.last_activity).toBe(staleActivity);

    // A ready lease IS still refreshed (sanity — the gate is state-specific).
    db().prepare("DELETE FROM gpu_leases").run();
    seedLease({ state: "ready", last_activity: staleActivity });
    mgr.touch("inst-1");
    expect(mgr.get("inst-1")!.last_activity).toBeGreaterThan(staleActivity);
    mgr.stop();
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

// ── SSH tunnel: autossh + probe retry ───────────────────────────────────────

describe("lease manager: SSH tunnel (autossh)", () => {
  it("startTunnel uses autossh -M 0 with ExitOnForwardFailure and ConnectTimeout", async () => {
    const vast = mockVast();
    const exec = mockExec();
    const mgr = createLeaseManager({ vast, exec, fileOps: mockFileOps() });

    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });

    const calls = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // Find the startTunnel exec call — it contains `autossh -M 0`.
    const tunnelStart = calls.find((c: unknown[]) => {
      const cmd = c[1] as string[];
      return cmd[0] === "bash" && cmd[2]?.includes("autossh");
    });
    expect(tunnelStart).toBeDefined();
    const tunnelCmd = (tunnelStart![1] as string[])[2];
    // Core autossh flags.
    expect(tunnelCmd).toContain("autossh -M 0 -f -N");
    expect(tunnelCmd).toContain("AUTOSSH_GATETIME=0");
    // SSH options that make startup failures visible + reliable death detection.
    expect(tunnelCmd).toContain("ExitOnForwardFailure=yes");
    expect(tunnelCmd).toContain("ConnectTimeout=10");
    expect(tunnelCmd).toContain("ServerAliveInterval=10");
    // The old swallowed-error pattern must be gone.
    expect(tunnelCmd).not.toContain("2>/dev/null || true");
  });

  it("stopTunnel kills autossh AND orphaned ssh children (correct pattern)", async () => {
    const vast = mockVast();
    const exec = mockExec();
    const mgr = createLeaseManager({ vast, exec, fileOps: mockFileOps() });

    await mgr.acquire({ instanceId: "inst-1", userId: 1, container: fakeContainer(), resume: false });
    await mgr.release("inst-1", "idle-timeout");

    const calls = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const stopCmd = calls.find((c: unknown[]) => {
      const cmd = c[1] as string[];
      return cmd[0] === "bash" && cmd[2]?.includes("pkill") && cmd[2]?.includes("autossh");
    });
    expect(stopCmd).toBeDefined();
    const cmdStr = (stopCmd![1] as string[])[2];
    // First pkill: kills autossh so it stops respawning ssh.
    expect(cmdStr).toContain('pkill -f "autossh.*9876:"');
    // Second pkill: kills orphaned ssh children. The pattern must match
    // "-N -L 9876:" (autossh passes -N and -L without -f). The old pattern
    // "ssh -NfL 9876:" didn't match, leaving orphans to hold port 9876.
    expect(cmdStr).toContain('pkill -f "ssh.*-L.*9876:"');
    // Must NOT use the old broken pattern.
    expect(cmdStr).not.toContain('ssh -NfL');
  });
});

describe("lease manager: watchdog tunnel probe retry", () => {
  it("does NOT restart when the tunnel probe succeeds (alive)", async () => {
    const vast = mockVast();
    const exec = mockExec();
    const mgr = createLeaseManager({
      vast,
      exec,
      fileOps: mockFileOps(),
      watchdogIntervalMs: 20,
      syncIntervalMs: 60_000, // don't let sync interfere
      idleReaperIntervalMs: 60_000,
    });
    // Tunnel is alive (default). Seed a ready lease so the watchdog checks it.
    seedLease({ state: "ready", manually_released: 0, vast_id: 500 });

    mgr.start();
    await new Promise((r) => setTimeout(r, 200));
    mgr.stop();

    const calls = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // No stopTunnel (pkill) should have been called — the tunnel is alive.
    const killCall = calls.find((c: unknown[]) => {
      const cmd = c[1] as string[];
      return cmd[0] === "bash" && cmd[2]?.includes("pkill");
    });
    expect(killCall).toBeUndefined();
  });

  it("restarts Blender in-place after 3 consecutive probe failures (dead Blender)", async () => {
    const vast = mockVast();
    const exec = mockExec();
    // Make the tunnel probe fail every time (simulates a crashed Blender behind
    // a live SSH tunnel + instance).
    exec.setTunnelAlive(false);
    const mgr = createLeaseManager({
      vast,
      exec,
      fileOps: mockFileOps(),
      watchdogIntervalMs: 20,
      syncIntervalMs: 60_000, // don't let sync interfere
      idleReaperIntervalMs: 60_000,
    });
    seedLease({ state: "ready", manually_released: 0, vast_id: 500 });

    mgr.start();
    // The probe retry does 3 attempts with 1s delays (~2s total) before
    // declaring dead, then restartBlender runs (SSH kill + relaunch + poll).
    // Wait long enough for one full probe cycle + restart.
    await new Promise((r) => setTimeout(r, 4000));
    mgr.stop();
    // Drain any in-flight tick so it can't touch the next test's seeded row.
    await new Promise((r) => setTimeout(r, 30));

    const calls = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // restartBlender SSHed into the instance to kill stale Blender.
    const killBlenderCall = calls.find((c: unknown[]) => {
      const cmd = c[1] as string[];
      return cmd[0] === "bash" && cmd[2]?.includes("ssh ") && cmd[2]?.includes("pkill -f blender");
    });
    expect(killBlenderCall).toBeDefined();
    // restartBlender SSHed in to relaunch Blender with the startup script.
    const relaunchCall = calls.find((c: unknown[]) => {
      const cmd = c[1] as string[];
      return cmd[0] === "bash" && cmd[2]?.includes("start_blender_mcp.py");
    });
    expect(relaunchCall).toBeDefined();
    // The tunnel was restarted as the final step of restartBlender.
    const autosshCalls = calls.filter((c: unknown[]) => {
      const cmd = c[1] as string[];
      return cmd[0] === "bash" && cmd[2]?.includes("autossh");
    });
    expect(autosshCalls.length).toBeGreaterThanOrEqual(1);
    // The lease transitioned through recovering → back to ready (the mock's
    // SSH commands succeed, so restartBlender returns true).
    const lease = mgr.get("inst-1");
    expect(lease?.state).toBe("ready");
  });
});

// ── Init-failure escalation ladder (reboot → blacklist → give up) ───────────

/**
 * A mock vast whose bringInstanceOnline path FAILS by making sshUrl return null
 * (→ "instance X has no ssh url" throw). `sshUrlFailCount` controls how many
 * sshUrl calls fail before it starts returning a real target. Since the reboot
 * tier reuses the SAME instance (no new createInstance), keying on sshUrl call
 * count (not createInstance count) correctly models "reboot fixed it".
 *
 * searchOffers returns offers with distinct machine_ids from `machineIds`,
 * cycling and skipping any in excludeMachineIds. This lets tests exercise the
 * full ladder: same machine fails → reboot → blacklist → different machine.
 */
function flakyInitVast(opts: {
  machineIds: number[];
  sshUrlFailCount: number; // sshUrl returns null for the first N calls, then a target
}): VastClient & { mocks: Record<string, ReturnType<typeof vi.fn>> } {
  let sshCallCount = 0;
  let createCount = 0;
  let offerIdx = 0;
  const mocks = {
    showUser: vi.fn(async () => ({})),
    searchOffers: vi.fn(async (searchOpts: { excludeMachineIds?: number[] } = {}): Promise<Offer[]> => {
      const exclude = new Set((searchOpts.excludeMachineIds ?? []).map(Number));
      // Find the next machine_id not excluded.
      for (let i = 0; i < opts.machineIds.length; i++) {
        const idx = (offerIdx + i) % opts.machineIds.length;
        const mid = opts.machineIds[idx];
        if (!exclude.has(mid)) {
          offerIdx = idx + 1;
          return [fakeOffer({ id: 100 + createCount, machine_id: mid })];
        }
      }
      return [];
    }),
    createInstance: vi.fn(async (): Promise<{ id: number }> => {
      const id = 500 + createCount;
      createCount++;
      return { id };
    }),
    getInstance: vi.fn(async (id: number): Promise<Instance | null> => fakeInstance({ id })),
    listInstances: vi.fn(async (): Promise<Instance[]> => [fakeInstance()]),
    waitForRunning: vi.fn(async (id: number): Promise<Instance> => fakeInstance({ id })),
    stopInstance: vi.fn(async () => undefined),
    startInstance: vi.fn(async () => undefined),
    rebootInstance: vi.fn(async () => undefined),
    destroyInstance: vi.fn(async () => undefined),
    sshUrl: vi.fn(async (): Promise<{ host: string; port: number } | null> => {
      sshCallCount++;
      if (sshCallCount <= opts.sshUrlFailCount) return null;
      return { host: "1.2.3.4", port: 12345 };
    }),
    createSshKey: vi.fn(async (): Promise<{ id: number }> => ({ id: 999 })),
    deleteSshKey: vi.fn(async () => undefined),
    attachSshKey: vi.fn(async () => undefined),
    listSshKeys: vi.fn(async (): Promise<Array<{ id: number; public_key: string }>> => []),
  };
  const client = mocks as unknown as VastClient & { mocks: typeof mocks };
  client.mocks = mocks;
  return client;
}

describe("lease manager: init-failure escalation ladder", () => {
  // These tests use a DISTINCT instance id ("inst-esc") to avoid colliding with
  // the module-level `inflight` lock map that prior tests (using "inst-1") may
  // have left populated. They do NOT start background loops (which would make
  // sshUrl call counts non-deterministic); instead they pump via retryQueued.
  const LADDER_OPTS = {
    exec: mockExec(),
    fileOps: mockFileOps(),
    rebootFailThreshold: 2,
    rebootWaitMs: 1000,
  };

  // Seed the escalation lane before each test (beforeEach only seeds inst-1).
  beforeEach(() => {
    db().prepare(
      "INSERT INTO workflow_instances (id, user_id, workflow_type, title, folder) VALUES ('inst-esc', 1, 'blender', 'Esc', '/workspace/blends/inst-esc')",
    ).run();
  });

  it("reboots the instance after 2 same-machine failures, then recovers", async () => {
    // sshUrl fails twice (2 init failures on machine 7000), then succeeds on
    // the reboot's bringInstanceOnline (3rd sshUrl call).
    const vast = flakyInitVast({ machineIds: [7000], sshUrlFailCount: 2 });
    const mgr = createLeaseManager({ vast, ...LADDER_OPTS });

    // Attempt 1: acquire → init fails → queued (fail 1).
    await mgr.acquire({ instanceId: "inst-esc", userId: 1, container: fakeContainer(), resume: false });
    expect(mgr.get("inst-esc")?.state).toBe("queued");
    // Attempt 2: retry → init fails again → reboot → bringInstanceOnline succeeds.
    await mgr.retryQueued("inst-esc");
    const lease = mgr.get("inst-esc");
    expect(vast.mocks.rebootInstance).toHaveBeenCalledOnce();
    expect(lease?.state).toBe("ready");
    expect(lease?.machine_fail_count).toBe(0);
    expect(lease?.escalation_stage).toBe("fresh");
  });

  it("blacklists the machine when reboot fails, then acquires a different machine", async () => {
    // sshUrl fails 3 times: attempt 1 (fail), attempt 2 + reboot (fail), then
    // attempt 3 on a different machine succeeds.
    const vast = flakyInitVast({ machineIds: [7000, 7001], sshUrlFailCount: 3 });
    const mgr = createLeaseManager({ vast, ...LADDER_OPTS });

    await mgr.acquire({ instanceId: "inst-esc", userId: 1, container: fakeContainer(), resume: false });
    // Attempt 2: retry → fails again → reboot → post-reboot init fails → blacklist → queued (post_blacklist).
    await mgr.retryQueued("inst-esc");
    expect(mgr.get("inst-esc")?.escalation_stage).toBe("post_blacklist");
    // Bad machine blacklisted.
    const blacklisted = db()
      .prepare("SELECT blacklisted FROM gpu_machine_health WHERE machine_id = 7000")
      .get() as { blacklisted: number } | undefined;
    expect(blacklisted?.blacklisted).toBe(1);
    // Attempt 3: retry → different machine 7001 → init succeeds → ready.
    await mgr.retryQueued("inst-esc");
    const lease = mgr.get("inst-esc");
    expect(lease?.state).toBe("ready");
    expect(lease?.machine_id).toBe(7001);
    expect(lease?.escalation_stage).toBe("fresh");
  });

  it("gives up (destroyed + manually_released) when the post-blacklist machine also fails", async () => {
    // sshUrl always fails → 7000 fails 2x → reboot fails → blacklist → 7001 fails → gave_up.
    const vast = flakyInitVast({ machineIds: [7000, 7001], sshUrlFailCount: 999 });
    const mgr = createLeaseManager({ vast, ...LADDER_OPTS });

    await mgr.acquire({ instanceId: "inst-esc", userId: 1, container: fakeContainer(), resume: false });
    await mgr.retryQueued("inst-esc"); // → blacklist 7000, post_blacklist
    await mgr.retryQueued("inst-esc"); // → 7001 fails, gave_up

    const lease = mgr.get("inst-esc");
    expect(lease?.state).toBe("destroyed");
    expect(lease?.manually_released).toBe(1);
    expect(lease?.escalation_stage).toBe("gave_up");
    expect(lease?.last_error).toMatch(/gave up|Click Acquire/i);
  });

  it("explicit re-acquire resets the escalation stage to fresh", async () => {
    // Seed a lease at destroyed + manually_released + post_blacklist (prior give-up).
    db()
      .prepare(
        `INSERT INTO gpu_leases (instance_id, user_id, state, vast_id, gpu_name, dph, ssh_host, ssh_port,
         queue_position, queue_requested_at, queue_last_checked_at, queue_search_error,
         acquired_at, last_activity, last_synced_at, last_error, manually_released, releasing_since,
         machine_id, machine_fail_count, escalation_stage)
         VALUES ('inst-esc', 1, 'destroyed', NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, 0, 0, NULL, 'gave up', 1, NULL,
         7000, 2, 'post_blacklist')`,
      )
      .run();
    const vast = mockVast();
    const mgr = createLeaseManager({ vast, exec: mockExec(), fileOps: mockFileOps() });
    const lease = await mgr.acquire({
      instanceId: "inst-esc",
      userId: 1,
      container: fakeContainer(),
      resume: true,
    });
    expect(lease.state).toBe("ready");
    expect(lease.manually_released).toBe(0);
    expect(lease.escalation_stage).toBe("fresh");
    expect(lease.machine_fail_count).toBe(0);
  });
});



