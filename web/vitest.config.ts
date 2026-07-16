import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Unit-test config: fast, jsdom environment for component tests, mocked native
// deps. Integration tests (gated on real API keys) live under
// `src/__tests__/integration/**` and run via vitest.integration.config.ts.
//
// Co-located with the app code so the `@/*` path alias resolves identically.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/__tests__/**/*.test.ts", "src/__tests__/**/*.test.tsx"],
    exclude: ["src/__tests__/integration/**", "node_modules/**"],
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
  },
});
