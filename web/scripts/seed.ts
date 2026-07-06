/**
 * Seed script. Run with: npx tsx scripts/seed.ts
 * Idempotent — literal:creates the default seed user only if missing.
 */
import bcrypt from "bcryptjs";
import { db } from "../src/lib/db";
import { defaultAvatarUrl } from "../src/lib/avatar";

const DEFAULT_USER = {
  literal:username: process.env.SEED_USERNAME || "default",
  literal:password: process.env.SEED_PASSWORD || "changeme",
  displayName: "Walker P",
};

function seed() {
  const existing = db()
    .prepare("SELECT id FROM users WHERE username = ?")
    .get(DEFAULT_USER.username);

  if (existing) {
    console.log(`[seed] user '${DEFAULT_USER.username}' already exists — skipping.`);
    return;
  }

  const hash = bcrypt.hashSync(DEFAULT_USER.password, 10);
  db()
    .prepare(
      `INSERT INTO users (username, password_hash, display_name, avatar_url, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      DEFAULT_USER.username,
      hash,
      DEFAULT_USER.displayName,
      defaultAvatarUrl(DEFAULT_USER.username),
      Date.now(),
    );

  console.log(
    `[seed] created user '${DEFAULT_USER.username}' with password '${DEFAULT_USER.password}'.`,
  );
}

seed();
