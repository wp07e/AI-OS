import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cookies } from "next/headers";
import { db, type UserRow } from "./db";

const COOKIE_NAME = "aios_session";

/**
 * Session signing secret. MUST be stable across server restarts — otherwise
 * every dev rebuild (HMR, file save, crash) invalidates all session cookies
 * and every logged-in user gets bounced to /login.
 *
 * Resolution order:
 *   1. AIOS_SESSION_SECRET env var (production / explicit override).
 *   2. web/data/.session-secret — generated on first run, persisted to disk.
 *   3. (fallback) random per-process — only used if the data dir is read-only.
 */
const SECRET = resolveSessionSecret();

/**
 * The session signing secret. Exposed so other token systems (e.g. public
 * asset-proxy tokens) can reuse the same stable secret rather than minting
 * their own. MUST be stable across restarts (handled by resolveSessionSecret).
 */
export function getAuthSecret(): string {
  return SECRET;
}

function resolveSessionSecret(): string {
  const fromEnv = process.env.AIOS_SESSION_SECRET;
  if (fromEnv) return fromEnv;

  const secretPath = resolve(process.cwd(), "data", ".session-secret");
  try {
    if (existsSync(secretPath)) {
      const existing = readFileSync(secretPath, "utf8").trim();
      if (existing.length >= 32) return existing;
    }
    mkdirSync(dirname(secretPath), { recursive: true });
    const generated = randomBytes(32).toString("hex");
    writeFileSync(secretPath, generated, { mode: 0o600 });
    return generated;
  } catch {
    // Data dir not writable (rare). Fall back to per-process secret — sessions
    // won't survive restarts, but the app still runs.
    return randomBytes(32).toString("hex");
  }
}

/** Sign a payload: token.body.signature (all hex). */
function sign(payload: string): string {
  const body = payload;
  const sig = createHmac("sha256", SECRET).update(body).digest("hex");
  return `${body}.${sig}`;
}

function verify(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac("sha256", SECRET).update(body).digest("hex");
  try {
    if (timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) {
      return body;
    }
  } catch {
    /* length mismatch → invalid */
  }
  return null;
}

/** Returns the authenticated user for the current request, or null. */
export async function currentUser(): Promise<UserRow | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const tokenBody = verify(token);
  if (!tokenBody) return null;

  const row = db()
    .prepare("SELECT * FROM sessions WHERE token = ?")
    .get(tokenBody) as { user_id: number } | undefined;
  if (!row) return null;

  return (
    db().prepare("SELECT * FROM users WHERE id = ?").get(row.user_id) as UserRow | undefined
  ) ?? null;
}

/** Verifies credentials and sets the session cookie. Returns true on success. */
export async function login(username: string, password: string): Promise<boolean> {
  const user = db()
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username) as UserRow | undefined;
  if (!user) return false;

  const { compareSync } = await import("bcryptjs");
  if (!compareSync(password, user.password_hash)) return false;

  const token = randomBytes(32).toString("hex");
  db()
    .prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)")
    .run(token, user.id, Date.now());

  const signed = sign(token);
  const store = await cookies();
  store.set(COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 1 week
  });
  return true;
}

export async function logout(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (token) {
    const body = verify(token);
    if (body) db().prepare("DELETE FROM sessions WHERE token = ?").run(body);
  }
  store.delete(COOKIE_NAME);
}
