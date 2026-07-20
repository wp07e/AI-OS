/**
 * Deterministic in-memory mock of the host's `execInContainer` (lib/docker.ts).
 *
 * Used ONLY when `AIOS_TEST_MOCK_DOCKER=1` is set (see the seam in
 * lib/docker.ts). Lets the Next.js dev server (booted by Playwright) service
 * both:
 *   - the workflow create/delete routes (mkdir / AGENTS.md write / rm -rf),
 *     which only check `.code === 0`; and
 *   - the lease manager's provisioning path (SSH keygen, key read, tunnel
 *     probes, blender-mcp socket sentinel), which parses command-specific
 *     stdout.
 *
 * To satisfy both, this mock implements the same SSH-keygen + tunnel state
 * machine as the unit-test `mockExec` in src/__tests__/gpu/_helpers.ts. State
 * (the fake key file) is held in a module-level Map so it survives across
 * requests within the booted server process.
 *
 * Production builds never parse this module: the require is gated on the env
 * flag inside execInContainer.
 */

import type { ContainerRow } from "./db";

// Stateful: track which fake files "exist" so the keygen flow is consistent.
const files = new Map<string, boolean>([
  ["/app/gpu/onstart.sh", true],
  ["/app/gpu/onstart-baked.sh", true],
]);

const ONSTART_BODY = "#!/bin/bash\nexit 0\n";
const ONSTART_BAKED_BODY = "#!/bin/bash\nexit 0\n";

/**
 * Returns a stateful execInContainer mock. The state lives at module scope so
 * a single booted dev server sees consistent file existence across requests.
 */
export function mockExecInContainer(): (
  row: ContainerRow,
  command: string[],
  opts?: { user?: string },
) => Promise<{ code: number; stdout: string; stderr: string }> {
  return async (_row, command, _opts) => {
    void _row;
    void _opts;
    const bashCmd = command[0] === "bash" && command[1] === "-lc" ? command[2] : "";
    const shCmd = command[0] === "sh" && command[1] === "-c" ? command[2] : "";

    // ── Lease-manager SSH key flow ─────────────────────────────────────────
    // `test -f /workspace/.ssh/gpu_ed25519 && echo exists`
    if (bashCmd.includes("test -f /workspace/.ssh/gpu_ed25519")) {
      return files.has("/workspace/.ssh/gpu_ed25519")
        ? { code: 0, stdout: "exists\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" };
    }
    // ssh-keygen for the GPU key
    if (bashCmd.includes("ssh-keygen") && bashCmd.includes("gpu_ed25519")) {
      files.set("/workspace/.ssh/gpu_ed25519", true);
      return { code: 0, stdout: "generated\n", stderr: "" };
    }
    // Read the public key
    if (bashCmd.includes("cat /workspace/.ssh/gpu_ed25519.pub")) {
      return { code: 0, stdout: "ssh-ed25519 AAAAC3test mock-key-for-tests\n", stderr: "" };
    }
    // SSH readiness probe
    if (bashCmd.includes("echo ssh_ready")) {
      return { code: 0, stdout: "ssh_ready\n", stderr: "" };
    }
    // Blender-mcp socket sentinel
    if (bashCmd.includes("blender-mcp-ready")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    // Local tunnel nc probe
    if (bashCmd.includes("nc -z 127.0.0.1")) {
      return { code: 0, stdout: "ok\n", stderr: "" };
    }
    // Generic bash (scp, ssh mkdir, tunnel start, AGENTS.md heredoc, etc.)
    if (command[0] === "bash" || command[0] === "sh") {
      return { code: 0, stdout: "", stderr: "" };
    }

    // ── File reads via `cat <path>` ────────────────────────────────────────
    if (command[0] === "cat" && command[1]) {
      if (command[1].endsWith("onstart-baked.sh")) return { code: 0, stdout: ONSTART_BAKED_BODY, stderr: "" };
      if (command[1].endsWith("onstart.sh")) return { code: 0, stdout: ONSTART_BODY, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }

    // ── File existence probes / mkdir / rm ─────────────────────────────────
    if (command[0] === "test" && command[1] === "-f" && command[2]) {
      return { code: files.has(command[2]) ? 0 : 1, stdout: "", stderr: "" };
    }
    if (command[0] === "mkdir") return { code: 0, stdout: "", stderr: "" };
    if (command[0] === "rm") return { code: 0, stdout: "", stderr: "" };

    // Permissive default — route handlers that only check `.code === 0` are
    // happy; the lease manager never reaches here for a probe it cares about.
    return { code: 0, stdout: "", stderr: "" };
  };
}
