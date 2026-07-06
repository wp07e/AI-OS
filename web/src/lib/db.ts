import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DB_PATH = resolve(process.cwd(), "data", "aios.db");

let _db: Database.Database | null = null;

/** Singleton DB handle. Migrations are idempotent and run on first open. */
export function db(): Database.Database {
  if (_db) return _db;

  mkdirSync(dirname(DB_PATH), { recursive: true });

  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");

  migrate(conn);
  _db = conn;
  return conn;
}

function migrate(conn: Database.Database) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      display_name  TEXT,
      avatar_url    TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS containers (
      user_id       INTEGER PRIMARY KEY,
      project_name  TEXT    NOT NULL,
      opencode_port INTEGER NOT NULL,
      oauth_port    INTEGER NOT NULL,
      relay_port    INTEGER NOT NULL,
      container_id  TEXT,
      status        TEXT    NOT NULL,
      created_at    INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Track the cached opencode session id per user (created lazily on first
    -- message). Allows multi-turn conversations across requests without forcing
    -- the user to start a new session each time.
    CREATE TABLE IF NOT EXISTS opencode_sessions (
      user_id         INTEGER PRIMARY KEY,
      session_id      TEXT    NOT NULL,
      opencode_port   INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: number;
}

export interface ContainerRow {
  user_id: number;
  project_name: string;
  opencode_port: number;
  oauth_port: number;
  relay_port: number;
  container_id: string | null;
  status: string;
  created_at: number;
}
