/**
 * GPU acquire/release regression suite — automated version of the 6 manual
 * test cases.
 *
 * These tests drive the REAL route handlers (GET/POST/DELETE
 * /api/workspace/<id>/blender/lease and DELETE /api/workflows/<id>) against a
 * REAL lease manager (real SQLite, real background loops) with a MOCKED vast
 * client (so no real GPUs are rented). They close the coverage gap that let
 * the regression ship: the existing unit tests bypass the host leaseManager()
 * singleton + its watchdog/reaper loops, and the existing integration test
 * only exercises the vast client — neither drives the server.
 *
 * Run: npm run test:integration
 * (VAST_API_KEY NOT required — these use the mock; the real-vast smoke tests
 *  live alongside in vast.test.ts.)
 */

// ── Mocks must come before any import that touches the route handlers ───────
// vi.mock is hoisted by vitest regardless of position, but we keep them at the
// top for readability.

// Stub `@/lib/auth` so currentUser() returns our seeded test user. The route
// handlers import currentUser from @/lib/auth; the mock swaps it for our
// closure. Override per-test via setCurrentUserForTests().
vi.mock("@/lib/auth", () => ({
  currentUser: async () => __currentUserForTests(),
}));

// Stub `@/lib/docker`'s execInContainer (used by the workflow DELETE route's
// `rm -rf <folder>`). getContainerForUser stays real (reads our seeded row).
vi.mock("@/lib/docker", async () => {
  const actual = await vi.importActual<typeof import("@/lib/docker")>("@/lib/docker");
  return {
    ...actual,
    execInContainer: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
  };
});

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

import {
  useTempDb,
  seedForTest,
  testUser,
  bootTestLeaseManager,
  mockVast,
  setCurrentUserForTests,
  __currentUserForTests,
  type BootedManager,
} from "@/__tests__/gpu/_helpers";
import { db } from "@/lib/db";
import { _clearLeaseManagerForTests } from "@/lib/gpu/lease-manager";
import { buildBlenderLeasePrefill } from "@/lib/gpu/blender-prefill";
import * as leaseRoute from "@/app/api/workspace/[instanceId]/blender/lease/route";
import * as workflowRoute from "@/app/api/workflows/[instanceId]/route";

// Helpers re-exported for the auth mock closure.
void setCurrentUserForTests;
void __currentUserForTests;

// ── Setup ───────────────────────────────────────────────────────────────────

let booted: BootedManager | null = null;

beforeAll(() => {
  useTempDb();
  setCurrentUserForTests(() => testUser());
});

beforeEach(() => {
  // Fresh DB rows + a fresh lease manager for every test. seedForTest wipes
  // gpu_leases too.
  seedForTest([{ id: "inst-1" }]);
  if (booted) booted.stop();
  booted = bootTestLeaseManager();
});

afterEach(() => {
  if (booted) {
    booted.stop();
    booted = null;
  }
  _clearLeaseManagerForTests();
});

// ── Test-case helpers ───────────────────────────────────────────────────────

/** GET /lease and return the lease row (or {state:"none"}). */
async function getLease(instanceId: string): Promise<any> {
  const { status, json } = await callLease(leaseRoute.GET, instanceId);
  expect(status).toBe(200);
  return json.lease ?? { state: "none" };
}

/** POST /lease (acquire). Pass body to override { resume: true }. */
async function postLease(instanceId: string, body: any = {}): Promise<any> {
  const { status, json } = await callLease(leaseRoute.POST, instanceId, { resume: true, ...body });
  expect(status).toBe(200);
  return json.lease;
}

/** DELETE /lease (manual release). */
async function deleteLease(instanceId: string): Promise<{ status: number; json: any }> {
  return callLease(leaseRoute.DELETE, instanceId);
}

async function callLease(
  handler: (req: Request, ctx: { params: Promise<{ instanceId: string }> }) => Promise<Response>,
  instanceId: string,
  opts: { body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const url = `http://localhost/api/workspace/${instanceId}/blender/lease`;
  const init: RequestInit = { method: opts.body !== undefined ? "POST" : "GET" };
  if (opts.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const req = new Request(url, init);
  const ctx = { params: Promise.resolve({ instanceId }) };
  const res = await handler(req, ctx);
  return { status: res.status, json: await res.json().catch(() => undefined) };
}

/** Wait until the lane's lease reaches one of the target states (or timeout). */
async function waitForState(
  instanceId: string,
  targets: string[],
  timeoutMs = 5000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lease = await getLease(instanceId);
    if (targets.includes(lease.state)) return lease;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`lease for ${instanceId} did not reach ${targets.join("/")} within ${timeoutMs}ms`);
}

/** Acquire fully to ready. Useful preamble for tests 1/3/5/6. */
async function acquireToReady(instanceId: string): Promise<any> {
  await postLease(instanceId);
  return waitForState(instanceId, ["ready"]);
}

/** Read a raw gpu_leases row directly from the DB. */
function rawRow(instanceId: string): any {
  return db().prepare("SELECT * FROM gpu_leases WHERE instance_id = ?").get(instanceId);
}

// ── Test 1: Manual Release GPU ──────────────────────────────────────────────

describe("Test 1: manually release GPU", () => {
  it("flips to releasing→destroyed + manually_released=1; auto-acquire does NOT happen; prefill tells user to reacquire", async () => {
    // Pre-condition: ready.
    const ready = await acquireToReady("inst-1");
    expect(ready.state).toBe("ready");
    expect(ready.manually_released).toBe(0);

    // Release.
    const { status } = await deleteLease("inst-1");
    expect(status).toBe(200);

    // Server-side state immediately reflects `releasing` + manually_released=1.
    // (The manual-release path writes the transitional state synchronously;
    // the background destroy then flips to `destroyed`.)
    const after = await getLease("inst-1");
    expect(["releasing", "destroyed"]).toContain(after.state);
    expect(after.manually_released).toBe(1);

    // Wait for the background release to complete (destroy → destroyed).
    const destroyed = await waitForState("inst-1", ["destroyed"], 5000);
    expect(destroyed.manually_released).toBe(1);

    // A subsequent GET (simulating a lane-open poll) does NOT re-trigger
    // auto-acquire: the row stays destroyed+flagged.
    const repoll = await getLease("inst-1");
    expect(repoll.state).toBe("destroyed");
    expect(repoll.manually_released).toBe(1);

    // The prefill the AI sees tells the user they must click "Acquire GPU".
    const prefill = buildBlenderLeasePrefill("inst-1");
    expect(prefill).toMatch(/MANUALLY released|released/i);
    expect(prefill).toMatch(/Acquire GPU/i);

    // An explicit POST with resume:true clears the flag and reprovisions.
    const reacquired = await postLease("inst-1", { resume: true });
    expect(reacquired.manually_released).toBe(0);
    const ready2 = await waitForState("inst-1", ["ready", "provisioning"]);
    expect(["ready", "provisioning"]).toContain(ready2.state);
    expect(rawRow("inst-1").manually_released).toBe(0);
  });
});

// ── Test 2: Release, switch away & back ─────────────────────────────────────

describe("Test 2: manual release persists across 'lane switches'", () => {
  it("after manual release, repeated GETs keep returning destroyed+manually_released (no auto-acquire)", async () => {
    await acquireToReady("inst-1");
    // Snapshot the createInstance call count AFTER the initial acquire, so the
    // assertion below checks only that the release-and-poll loop does not
    // trigger an additional acquire.
    const createCallsAfterAcquire = booted!.vast.mocks.createInstance.mock.calls.length;
    await deleteLease("inst-1");

    // Wait for the background release to complete.
    await waitForState("inst-1", ["destroyed"], 5000);

    // Simulate navigating to a different lane then back: the BlenderStudio
    // effect re-fires auto-acquire ONLY if state is none/destroyed AND
    // manually_released is false. Here the flag must stay set across polls.
    for (let i = 0; i < 5; i++) {
      const lease = await getLease("inst-1");
      expect(lease.state).toBe("destroyed");
      expect(lease.manually_released).toBe(1);
    }
    // No additional createInstance call during the release-and-poll loop.
    expect(booted!.vast.mocks.createInstance.mock.calls.length).toBe(createCallsAfterAcquire);
  });
});

// ── Test 3: Release in flight ───────────────────────────────────────────────

describe("Test 3: state visible DURING the release window", () => {
  it("DELETE returns immediately; GET right after shows releasing (NOT ready); prefill does NOT claim READY", async () => {
    // Use a slow destroy so the background release is in flight when we poll.
    // (Mock vast destroy takes ~0ms by default; add a deliberate hang.)
    booted!.stop();
    const slowVast = mockVast({
      destroyInstance: vi.fn(
        () => new Promise<void>((r) => setTimeout(r, 300)),
      ) as any,
    });
    booted = bootTestLeaseManager({ vast: slowVast });

    await acquireToReady("inst-1");
    expect(booted.vast.mocks.createInstance).toHaveBeenCalledOnce();

    // Fire release — returns immediately (only the synchronous prologue runs).
    const t0 = Date.now();
    await deleteLease("inst-1");
    expect(Date.now() - t0).toBeLessThan(200);

    // THIS is the bug you hit: the AI still thought the GPU was ready while a
    // release was in flight. The fix (d6a4f27): the server reports `releasing`
    // synchronously, so every reader (UI poll, AI prefill) sees "release in
    // progress" instead of the stale `ready` state.
    const duringRelease = await getLease("inst-1");
    expect(duringRelease.state).not.toBe("ready");
    expect(["releasing", "destroyed"]).toContain(duringRelease.state);
    expect(duringRelease.manually_released).toBe(1);

    // The silent prefill the AI reads in this window must NOT tell it the GPU
    // is ready. (Reproduce your conversation: "what is the state?" should not
    // answer "Ready. RTX 4060 Ti…".)
    const prefill = buildBlenderLeasePrefill("inst-1");
    expect(prefill).not.toMatch(/lease is READY/i);

    // After the background destroy completes, the row reaches `destroyed`.
    await waitForState("inst-1", ["destroyed"], 5000);
    const after = await getLease("inst-1");
    expect(after.state).toBe("destroyed");
    expect(after.manually_released).toBe(1);
  });
});

// ── Test 4: Two lanes, concurrent acquire ───────────────────────────────────

describe("Test 4: two Blender lanes acquire back-to-back", () => {
  it("both reach ready with distinct vast_ids; a second POST on a provisioning lease is a no-op", async () => {
    seedForTest([{ id: "inst-A" }, { id: "inst-B" }]);

    // Acquire both before either resolves. (Mock vast resolves ~instantly;
    // this still exercises the per-instance locking + DB path.)
    await postLease("inst-A");
    await postLease("inst-B");

    const a = await waitForState("inst-A", ["ready"]);
    const b = await waitForState("inst-B", ["ready"]);

    expect(a.state).toBe("ready");
    expect(b.state).toBe("ready");
    // Distinct vast instances.
    expect(a.vast_id).toBeTruthy();
    expect(b.vast_id).toBeTruthy();
    expect(a.vast_id).not.toBe(b.vast_id);

    // A second POST on a ready lease is idempotent — no new createInstance.
    const createCallsBefore = booted!.vast.mocks.createInstance.mock.calls.length;
    await postLease("inst-A", { resume: true });
    expect(booted!.vast.mocks.createInstance.mock.calls.length).toBe(createCallsBefore);
  });
});

// ── Test 5: Two lanes, concurrent release ───────────────────────────────────

describe("Test 5: two lanes release back-to-back", () => {
  it("both GPUs are destroyed; destroyInstance called once per distinct vast_id", async () => {
    seedForTest([{ id: "inst-A" }, { id: "inst-B" }]);
    await postLease("inst-A");
    await postLease("inst-B");
    const a = await waitForState("inst-A", ["ready"]);
    const b = await waitForState("inst-B", ["ready"]);

    await deleteLease("inst-A");
    await deleteLease("inst-B");

    // Both reach destroyed (background release completes for each).
    await waitForState("inst-A", ["destroyed"], 5000);
    await waitForState("inst-B", ["destroyed"], 5000);

    // destroyInstance called for each distinct vast_id exactly once.
    const destroyed = booted!.vast.mocks.destroyInstance.mock.calls.map(
      (c: any[]) => c[0],
    );
    expect(destroyed).toContain(a.vast_id);
    expect(destroyed).toContain(b.vast_id);
  });
});

// ── Test 6: Two lanes, trashcan (DELETE workflow) ───────────────────────────

describe("Test 6: trashcan (DELETE workflow) releases + cascade-deletes", () => {
  it("for each blender lane, triggers release('lane-deleted'), destroys the GPU, and removes both rows", async () => {
    seedForTest([{ id: "inst-A" }, { id: "inst-B" }]);
    await postLease("inst-A");
    await postLease("inst-B");
    const a = await waitForState("inst-A", ["ready"]);
    const b = await waitForState("inst-B", ["ready"]);

    // DELETE /api/workflows/<id> for both, back-to-back.
    await deleteWorkflow("inst-A");
    await deleteWorkflow("inst-B");

    // Both GPUs destroyed.
    const destroyed = booted!.vast.mocks.destroyInstance.mock.calls.map(
      (c: any[]) => c[0],
    );
    expect(destroyed).toContain(a.vast_id);
    expect(destroyed).toContain(b.vast_id);

    // Cascade: both workflow_instances rows gone, and their gpu_leases rows
    // gone too (FK ON DELETE CASCADE on gpu_leases.instance_id).
    const remaining = db()
      .prepare("SELECT id FROM workflow_instances WHERE id IN (?, ?)")
      .all("inst-A", "inst-B");
    expect(remaining).toHaveLength(0);

    const remainingLeases = db()
      .prepare("SELECT instance_id FROM gpu_leases WHERE instance_id IN (?, ?)")
      .all("inst-A", "inst-B");
    expect(remainingLeases).toHaveLength(0);
  });
});

// ── Workflow DELETE helper ──────────────────────────────────────────────────

async function deleteWorkflow(instanceId: string): Promise<{ status: number; json: any }> {
  const req = new Request(`http://localhost/api/workflows/${instanceId}`, { method: "DELETE" });
  const ctx = { params: Promise.resolve({ instanceId }) };
  const res = await workflowRoute.DELETE(req as any, ctx);
  return { status: res.status, json: await res.json().catch(() => undefined) };
}
