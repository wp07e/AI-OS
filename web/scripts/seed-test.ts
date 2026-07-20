/**
 * Test-only seed for Playwright runs.
 *
 * Seeds a fresh test DB (pointed at by DB_PATH) with:
 *   - the SEED_USERNAME/SEED_PASSWORD user
 *   - a READY container row for that user (so the Blender lease POST doesn't
 *     409 "container not ready" — the mock-vast path doesn't need docker)
 *
 * Idempotent: wipes users/containers/workflow_instances first so each Playwright
 * run starts clean. Run via `tsx scripts/seed-test.ts` before booting next dev.
 *
 * NOT for production. The real scripts/seed.ts intentionally does NOT create a
 * container (one is provisioned on first login via the docker flow).
 */

import bcrypt from "bcryptjs";
import { db } from "../src/lib/db";

const username = process.env.SEED_USERNAME;
const password = process.env.SEED_PASSWORD;

if (!username || !password) {
  throw new Error(
    "[seed-test] SEED_USERNAME and SEED_PASSWORD must be set (Playwright test creds).",
  );
}

// Wipe all dynamic state so runs are hermetic.
db().prepare("DELETE FROM gpu_leases").run();
db().prepare("DELETE FROM workflow_instances").run();
db().prepare("DELETE FROM containers").run();
db().prepare("DELETE FROM users").run();

const hash = bcrypt.hashSync(password, 10);
db()
  .prepare(
    `INSERT INTO users (username, password_hash, display_name, avatar_url, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  .run(username, hash, username, "", Date.now());

const user = db().prepare("SELECT id FROM users WHERE username = ?").get(username) as {
  id: number;
};

// A ready container for the seeded user. The lease routes require
// container.status === "ready"; the mock-vast path never touches docker.
db()
  .prepare(
    `INSERT INTO containers (user_id, project_name, opencode_port, oauth_port, relay_port, container_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ready', ?)`,
  )
  .run(user.id, "aios-test", 4100, 19800, 19801, "test-container", Date.now());

console.log(`[seed-test] seeded user '${username}' + ready container for Playwright.`);
