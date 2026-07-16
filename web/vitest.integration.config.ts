import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Integration-test config: node environment (no jsdom), longer timeouts.
// These tests are gated on real API keys (e.g. VAST_API_KEY) and SKIP
// automatically when the key is absent, so this config is safe to run in CI.
// Run with: npm run test:integration
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/__tests__/integration/**/*.test.ts"],
    globals: true,
    testTimeout: 600_000, // 10 min — vast provisioning can take minutes
    hookTimeout: 600_000,
  },
});
