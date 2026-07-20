import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Playwright config for the GPU/UI smoke suite.
 *
 * Boots a next dev server against a FRESH test DB (DB_PATH) with the vast mock
 * enabled (AIOS_TEST_MOCK_VAST=1). The mock lets the full server-side lease
 * state machine run without renting real GPUs. A dedicated seed script
 * (scripts/seed-test.ts) inserts the test user + a ready container so the
 * Blender lease POST doesn't 409.
 *
 * Run: npm run test:e2e
 *
 * Auth: each test logs in via /api/login (see e2e/_auth.ts). We don't use a
 * global storageState because some tests assert on logged-out behavior; keeping
 * login per-test is simpler and fast enough.
 */

const port = 3111;
const testDbPath = resolve(__dirname, "data/playwright-test.db");
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // shared test DB + mock-vast state — serialize
  forbidTimeoutsInHooks: true,
  workers: 1,
  reporter: process.env.CI ? "list" : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    // Generous because the mock-vast boot transition is ~200ms but lane
    // creation + auto-acquire polling (5s cadence in useBlenderState) can take
    // a few seconds to settle.
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `tsx scripts/seed-test.ts && next dev --port ${port}`,
    url: baseURL,
    timeout: 120_000, // next dev cold start + seed
    reuseExistingServer: !process.env.CI,
    cwd: __dirname,
    env: {
      ...process.env,
      DB_PATH: testDbPath,
      AIOS_TEST_MOCK_VAST: "1",
      // The workflow create/delete routes shell out to `docker compose exec
      // ai-os ...`. Mock docker so the dev server doesn't need a real ai-os
      // container to service lane operations.
      AIOS_TEST_MOCK_DOCKER: "1",
      // Stretch the destroy window so Test 3's "during release" assertion has a
      // reliable window to observe. Boot is fast (200ms) so acquire stays quick.
      AIOS_TEST_VAST_DESTROY_MS: "1500",
      SEED_USERNAME: process.env.SEED_USERNAME ?? "tester",
      SEED_PASSWORD: process.env.SEED_PASSWORD ?? "tester123",
    } as Record<string, string>,
  },
});
