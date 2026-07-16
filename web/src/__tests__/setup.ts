import "@testing-library/jest-dom/vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Global test setup. Runs before ALL test files in the worker. Setting
// DB_PATH here ensures the db.ts singleton NEVER connects to the production
// database — even if a test file imports db.ts before setting its own path.
// Individual test files that need isolation call _resetDbForTests() with their
// own DB_PATH to get a fresh connection.
const _testDbDir = mkdtempSync(resolve(tmpdir(), "aios-test-"));
process.env.DB_PATH = resolve(_testDbDir, "global-test.db");

// Speed up GPU polling loops in tests (the mocked transport returns instantly,
// so the default 5s interval would blow the 5s vitest timeout on the first
// poll cycle).
process.env.GPU_POLL_INTERVAL_MS = "10";
