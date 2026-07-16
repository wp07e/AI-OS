/**
 * Unit tests for the vast.ai client wrapper (lib/gpu/vast.ts).
 *
 * The transport is mocked, so these run without the real `vastai` CLI or an API
 * key. Integration tests (real CLI, gated on VAST_API_KEY) live in
 * `src/__tests__/integration/vast.test.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import {
  ALLOWED_GPUS,
  buildSearchQuery,
  createVastClient,
  gpuNameToQuery,
  minCudaFor,
  DEFAULT_MAX_DPH,
  type Transport,
  type CliResult,
  VastError,
} from "@/lib/gpu/vast";
import type { Instance, Offer } from "@/lib/gpu/types";

// ── Transport helpers ──────────────────────────────────────────────────────

/** A mock transport that returns scripted responses per call. */
function scriptedTransport(responses: CliResult[]): Transport {
  let i = 0;
  return vi.fn(async () => responses[i++] ?? { code: 0, stdout: "", stderr: "" }) as unknown as Transport;
}

/** Build a fake offer object. */
function fakeOffer(over: Partial<Offer> = {}): Offer {
  return {
    id: 100,
    gpu_name: "RTX 4060",
    num_gpus: 1,
    dph_total: 0.07,
    dlperf: 50,
    dlperf_per_dphtotal: 700,
    cuda_max_good: 12.4,
    reliability2: 0.99,
    rentable: true,
    ...over,
  };
}

function okJson(stdout: unknown): CliResult {
  return { code: 0, stdout: JSON.stringify(stdout), stderr: "" };
}

// ── gpuNameToQuery / minCudaFor ────────────────────────────────────────────

describe("gpuNameToQuery", () => {
  it("replaces spaces with underscores", () => {
    expect(gpuNameToQuery("RTX 4060 Ti")).toBe("RTX_4060_Ti");
    expect(gpuNameToQuery("RTX A4000")).toBe("RTX_A4000");
  });
});

describe("minCudaFor", () => {
  it("requires 12.8 for RTX 5-series", () => {
    expect(minCudaFor("RTX 5060")).toBe(12.8);
    expect(minCudaFor("RTX 5060 Ti")).toBe(12.8);
  });
  it("defaults to 12.0 for other GPUs", () => {
    expect(minCudaFor("RTX 4060")).toBe(12.0);
    expect(minCudaFor("RTX A4000")).toBe(12.0);
  });
});

// ── buildSearchQuery (per-GPU query builder) ───────────────────────────────

describe("buildSearchQuery", () => {
  it("includes the price cap from DEFAULT_MAX_DPH", () => {
    const q = buildSearchQuery("RTX 4060");
    expect(q).toContain(`dph_total<=${DEFAULT_MAX_DPH}`);
  });

  it("uses the GPU name in underscore form", () => {
    const q = buildSearchQuery("RTX 4060 Ti");
    expect(q).toContain("gpu_name=RTX_4060_Ti");
    expect(q).not.toContain("|");
  });

  it("requires cuda_max_good >= 12.8 for 5-series", () => {
    const q = buildSearchQuery("RTX 5060");
    expect(q).toContain("cuda_max_good>=12.8");
  });

  it("requires cuda_max_good >= 12.0 for 4-series", () => {
    const q = buildSearchQuery("RTX 4060");
    expect(q).toContain("cuda_max_good>=12");
    expect(q).not.toContain("12.8");
  });

  it("respects a custom maxDph", () => {
    const q = buildSearchQuery("RTX 4060", { maxDph: 0.2 });
    expect(q).toContain("dph_total<=0.2");
  });

  it("defaults to verified=true", () => {
    expect(buildSearchQuery("RTX 4060")).toContain("verified=true");
  });

  it("includes geolocation in [XX,YY] when geolocations is set", () => {
    const q = buildSearchQuery("RTX 4060", { geolocations: ["TW", "JP", "KR"] });
    expect(q).toContain("geolocation in [TW,JP,KR]");
  });

  it("omits geolocation when geolocations is empty", () => {
    const q = buildSearchQuery("RTX 4060", { geolocations: [] });
    expect(q).not.toContain("geolocation");
  });
});

// ── searchOffers (mocked transport) ────────────────────────────────────────

describe("searchOffers", () => {
  it("filters out offers over the cap even if the CLI returns them", async () => {
    // searchOffers searches each GPU separately; with a single GPU model it
    // makes one call.
    const offers = [
      fakeOffer({ id: 1, dph_total: 0.05 }),
      fakeOffer({ id: 2, dph_total: 0.5 }), // over cap
    ];
    const transport = scriptedTransport([okJson(offers)]);
    const client = createVastClient(transport);
    const result = await client.searchOffers({ gpuModels: ["RTX 4060"] }, transport);
    expect(result.map((o) => o.id)).toEqual([1]);
  });

  it("filters out offers below the CUDA floor", async () => {
    const offers = [
      fakeOffer({ id: 1, gpu_name: "RTX 5060", cuda_max_good: 12.4 }), // below 12.8
      fakeOffer({ id: 2, gpu_name: "RTX 5060", cuda_max_good: 12.9 }),
    ];
    const transport = scriptedTransport([okJson(offers)]);
    const client = createVastClient(transport);
    const result = await client.searchOffers({ gpuModels: ["RTX 5060"] }, transport);
    expect(result.map((o) => o.id)).toEqual([2]);
  });

  it("passes --raw and the type flag to the CLI", async () => {
    const offers: Offer[] = [fakeOffer()];
    const transport = scriptedTransport([okJson(offers)]);
    const client = createVastClient(transport);
    await client.searchOffers({ gpuModels: ["RTX 4060"], type: "interruptible" }, transport);
    const args = (transport as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(args).toContain("--raw");
    expect(args).toContain("interruptible");
  });

  it("merges results from multiple GPU searches", async () => {
    // Two GPU models → two calls, each returning one offer.
    const transport = scriptedTransport([
      okJson([fakeOffer({ id: 1, gpu_name: "RTX 4060", dlperf_per_dphtotal: 700 })]),
      okJson([fakeOffer({ id: 2, gpu_name: "RTX A4000", dlperf_per_dphtotal: 800 })]),
    ]);
    const client = createVastClient(transport);
    const result = await client.searchOffers({ gpuModels: ["RTX 4060", "RTX A4000"] }, transport);
    expect(result).toHaveLength(2);
    // Sorted by dlperf_per_dphtotal descending → A4000 (800) first.
    expect(result[0].id).toBe(2);
    expect(result[1].id).toBe(1);
  });
});

// ── createInstance ─────────────────────────────────────────────────────────

describe("createInstance", () => {
  it("parses the instance id from CLI output", async () => {
    const transport = scriptedTransport([
      { code: 0, stdout: "Allocated ID: 12345\n", stderr: "" },
    ]);
    const client = createVastClient(transport);
    process.env.VAST_API_KEY = "test-key";
    const { id } = await client.createInstance({ offerId: 100, image: "nvidia/cuda:12.4.1-runtime-ubuntu22.04" }, transport);
    expect(id).toBe(12345);
    delete process.env.VAST_API_KEY;
  });

  it("throws VastError when the CLI exits non-zero", async () => {
    const transport = scriptedTransport([
      { code: 1, stdout: "", stderr: "offer no longer available" },
    ]);
    const client = createVastClient(transport);
    process.env.VAST_API_KEY = "test-key";
    await expect(
      client.createInstance({ offerId: 100, image: "nvidia/cuda:12.4.1-runtime-ubuntu22.04" }, transport),
    ).rejects.toBeInstanceOf(VastError);
    delete process.env.VAST_API_KEY;
  });

  it("includes onstart, label, and --force when provided", async () => {
    const transport = scriptedTransport([
      { code: 0, stdout: "Allocated ID: 99999\n", stderr: "" },
    ]);
    const client = createVastClient(transport);
    process.env.VAST_API_KEY = "test-key";
    await client.createInstance(
      { offerId: 7, image: "img", onstart: "echo hi", label: "blender-x" },
      transport,
    );
    const args = (transport as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(args).toContain("--onstart-cmd");
    expect(args).toContain("echo hi");
    expect(args).toContain("--label");
    expect(args).toContain("blender-x");
    expect(args).toContain("--force");
    delete process.env.VAST_API_KEY;
  });
});

// ── getInstance / waitForRunning ───────────────────────────────────────────

describe("getInstance + waitForRunning", () => {
  it("resolves when cur_state becomes running", async () => {
    const states: Instance[] = [
      { id: 1, cur_state: "requested" },
      { id: 1, cur_state: "loading" },
      { id: 1, cur_state: "running" },
    ];
    // Each getInstance call hits show instances → return the next state.
    const responses = states.map((s) => okJson([s]));
    const transport = scriptedTransport(responses);
    const client = createVastClient(transport);
    const inst = await client.waitForRunning(1, 60_000, transport);
    expect(inst.cur_state).toBe("running");
  });

  it("throws if the instance enters error state", async () => {
    const transport = scriptedTransport([okJson([{ id: 1, cur_state: "error" }])]);
    const client = createVastClient(transport);
    await expect(client.waitForRunning(1, 60_000, transport)).rejects.toBeInstanceOf(VastError);
  });

  it("throws if the instance vanishes (getInstance returns null)", async () => {
    const transport = scriptedTransport([okJson([])]);
    const client = createVastClient(transport);
    await expect(client.waitForRunning(1, 60_000, transport)).rejects.toBeInstanceOf(VastError);
  });
});

// ── stop / start / destroy ─────────────────────────────────────────────────

describe("stop / start / destroy", () => {
  it("stop calls stop instance and tolerates already-paused", async () => {
    const transport = scriptedTransport([
      { code: 1, stdout: "", stderr: "already paused" },
    ]);
    const client = createVastClient(transport);
    await expect(client.stopInstance(1, transport)).resolves.toBeUndefined();
  });

  it("start calls start instance and tolerates already-running", async () => {
    const transport = scriptedTransport([
      { code: 1, stdout: "", stderr: "already running" },
    ]);
    const client = createVastClient(transport);
    await expect(client.startInstance(1, transport)).resolves.toBeUndefined();
  });

  it("destroy calls destroy instance -y", async () => {
    const transport = scriptedTransport([{ code: 0, stdout: "", stderr: "" }]);
    const client = createVastClient(transport);
    await client.destroyInstance(1, transport);
    const args = (transport as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(args).toEqual(["destroy", "instance", "1", "-y"]);
  });

  it("destroy tolerates already-destroyed (idempotent)", async () => {
    const transport = scriptedTransport([
      { code: 1, stdout: "", stderr: "not found" },
    ]);
    const client = createVastClient(transport);
    await expect(client.destroyInstance(1, transport)).resolves.toBeUndefined();
  });
});

// ── sshUrl ─────────────────────────────────────────────────────────────────

describe("sshUrl", () => {
  it("parses host and port from ssh-url output", async () => {
    const transport = scriptedTransport([
      { code: 0, stdout: "ssh://root@1.2.3.4:12345\n", stderr: "" },
    ]);
    const client = createVastClient(transport);
    const target = await client.sshUrl(1, transport);
    expect(target).toEqual({ host: "1.2.3.4", port: 12345 });
  });

  it("returns null when the CLI fails", async () => {
    const transport = scriptedTransport([{ code: 1, stdout: "", stderr: "no ssh" }]);
    const client = createVastClient(transport);
    const target = await client.sshUrl(1, transport);
    expect(target).toBeNull();
  });
});

// ── instanceLogs ───────────────────────────────────────────────────────────

describe("instanceLogs", () => {
  it("calls vastai logs with --tail, --filter for onstart lines, and --full", async () => {
    const transport = scriptedTransport([
      { code: 0, stdout: "[2026-01-01T00:00:00Z] booting blender...\n[2026-01-01T00:00:05Z] socket ready\n", stderr: "" },
    ]);
    const client = createVastClient(transport);
    const logs = await client.instanceLogs(42, 8, transport);
    expect(logs).toBe("[2026-01-01T00:00:00Z] booting blender...\n[2026-01-01T00:00:05Z] socket ready");
    const args = (transport as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(args).toEqual(["logs", "42", "--tail", "8", "--filter", "\\[", "--full"]);
  });

  it("returns empty string on CLI failure", async () => {
    const transport = scriptedTransport([{ code: 1, stdout: "", stderr: "no logs" }]);
    const client = createVastClient(transport);
    const logs = await client.instanceLogs(42, 30, transport);
    expect(logs).toBe("");
  });
});
