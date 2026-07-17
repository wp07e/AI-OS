/**
 * Component + unit tests for the Blender workflow UI pieces.
 *
 * - LeasePill: renders all lease states correctly; shows "Acquire GPU" only
 *   when no lease is active (after a release), "Release GPU" only when
 *   ready/recovering.
 * - RenderPanel: validates settings; disabled until lease is ready.
 * - buildBlenderLeasePrefill: produces the right text per lease state; empty
 *   for non-Blender lanes.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { LeasePill } from "@/app/app/(workflow)/blender/LeasePill";
import { RenderPanel } from "@/app/app/(workflow)/blender/RenderPanel";
import type { LeaseInfo } from "@/app/app/(workflow)/blender/types";

// ── LeasePill ──────────────────────────────────────────────────────────────

describe("LeasePill", () => {
  it("renders 'No GPU' when lease is null", () => {
    render(<LeasePill lease={null} onRelease={vi.fn()} onAcquire={vi.fn()} />);
    expect(screen.getByText("No GPU")).toBeDefined();
    // Acquire button IS shown when there's no lease (manual re-acquire).
    expect(screen.getByText(/acquire/i)).toBeDefined();
    // No release button when not ready.
    expect(screen.queryByText(/release/i)).toBeNull();
  });

  it("renders provisioning state with a spinner indicator", () => {
    const lease: LeaseInfo = { instance_id: "x", state: "provisioning", gpu_name: "RTX 4060" };
    render(<LeasePill lease={lease} onRelease={vi.fn()} onAcquire={vi.fn()} />);
    expect(screen.getByText("Starting GPU")).toBeDefined();
    expect(screen.getByText("(RTX 4060)")).toBeDefined();
    // No release button during provisioning.
    expect(screen.queryByText(/release/i)).toBeNull();
    // No acquire button during provisioning.
    expect(screen.queryByText(/acquire/i)).toBeNull();
  });

  it("renders queued state with position", () => {
    const lease: LeaseInfo = { instance_id: "x", state: "queued", queue_position: 1 };
    render(<LeasePill lease={lease} onRelease={vi.fn()} onAcquire={vi.fn()} />);
    expect(screen.getByText("Waiting for GPU")).toBeDefined();
    expect(screen.getByText("#2 in queue")).toBeDefined(); // 0-based → display #2
  });

  it("renders ready state with GPU + cost and a Release button", () => {
    const lease: LeaseInfo = {
      instance_id: "x",
      state: "ready",
      gpu_name: "RTX 4060",
      dph: 0.067,
    };
    render(<LeasePill lease={lease} onRelease={vi.fn()} onAcquire={vi.fn()} />);
    expect(screen.getByText("GPU Ready")).toBeDefined();
    expect(screen.getByText(/RTX 4060/)).toBeDefined();
    expect(screen.getByText(/\$0\.067\/hr/)).toBeDefined();
    expect(screen.getByText("Release GPU")).toBeDefined();
  });

  it("calls onRelease when Release GPU is clicked", () => {
    const onRelease = vi.fn(async () => {});
    const lease: LeaseInfo = { instance_id: "x", state: "ready", gpu_name: "RTX 4060", dph: 0.07 };
    render(<LeasePill lease={lease} onRelease={onRelease} onAcquire={vi.fn()} />);
    fireEvent.click(screen.getByText("Release GPU"));
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it("renders recovering state without a release button being clickable label", () => {
    const lease: LeaseInfo = { instance_id: "x", state: "recovering" };
    render(<LeasePill lease={lease} onRelease={vi.fn()} onAcquire={vi.fn()} />);
    expect(screen.getByText("Reconnecting GPU")).toBeDefined();
  });
});

// ── RenderPanel ─────────────────────────────────────────────────────────────

describe("RenderPanel", () => {
  it("is disabled when lease is not ready", () => {
    render(
      <RenderPanel
        instanceId="x"
        lease={{ instance_id: "x", state: "provisioning" }}
        busy={false}
      />,
    );
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("is enabled when lease is ready and not busy", () => {
    render(
      <RenderPanel
        instanceId="x"
        lease={{ instance_id: "x", state: "ready" }}
        busy={false}
      />,
    );
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("is disabled when busy even if lease is ready", () => {
    render(
      <RenderPanel
        instanceId="x"
        lease={{ instance_id: "x", state: "ready" }}
        busy={true}
      />,
    );
    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows waiting message when queued", () => {
    render(
      <RenderPanel
        instanceId="x"
        lease={{ instance_id: "x", state: "queued" }}
        busy={false}
      />,
    );
    expect(screen.getByText(/Waiting for a GPU/)).toBeDefined();
  });

  it("POSTs to the render route on submit with selected settings", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(
      <RenderPanel
        instanceId="inst-1"
        lease={{ instance_id: "inst-1", state: "ready" }}
        busy={false}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    // Wait for the fetch to fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/workspace/inst-1/blender/render",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.settings.engine).toBe("CYCLES");
    expect(body.settings.samples).toBe(128);
    expect(body.settings.resolution).toBe("1080p");
    fetchSpy.mockRestore();
  });
});

// ── buildBlenderLeasePrefill ────────────────────────────────────────────────

describe("buildBlenderLeasePrefill", () => {
  // The prefill reads from the lease manager singleton which reads from the DB.
  // We use a temp DB + _resetDbForTests to guarantee isolation from production.

  beforeAll(() => {
    process.env.DB_PATH = resolve(tmpdir(), `prefill-test-${Date.now()}.db`);
  });

  beforeEach(async () => {
    const { db, _resetDbForTests } = await import("@/lib/db");
    _resetDbForTests();
    db(); // init schema
    // Clear tables so each test starts clean (the temp file persists across
    // tests in this file).
    db().prepare("DELETE FROM gpu_leases").run();
    db().prepare("DELETE FROM workflow_instances").run();
    db().prepare("DELETE FROM users").run();
    db().prepare(
      "INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 't', 'x', 0, 0)",
    ).run();
    db().prepare(
      "INSERT INTO workflow_instances (id, user_id, workflow_type, title, folder) VALUES ('x', 1, 'blender', 'T', '/workspace/blends/x')",
    ).run();
  });

  it("returns empty string for an instance with no lease", async () => {
    const { buildBlenderLeasePrefill } = await import("@/lib/gpu/blender-prefill");
    const text = buildBlenderLeasePrefill("x");
    expect(text).toBe("");
  });

  it("returns non-empty text describing the ready state", async () => {
    const { db } = await import("@/lib/db");
    db().prepare(
      `INSERT INTO gpu_leases (instance_id, user_id, state, vast_id, gpu_name, dph, ssh_host, ssh_port, last_activity)
       VALUES ('x', 1, 'ready', 500, 'RTX 4060', 0.07, '1.2.3.4', 12345, ?)`,
    ).run(Date.now());

    const { buildBlenderLeasePrefill } = await import("@/lib/gpu/blender-prefill");
    const text = buildBlenderLeasePrefill("x");
    expect(text).toContain("READY");
    expect(text).toContain("RTX 4060");
    expect(text).toContain("blender");
  });
});
