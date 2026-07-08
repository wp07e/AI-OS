import { randomBytes } from "node:crypto";

/**
 * In-memory store for single-use OAuth relay bearer tokens.
 *
 * When the user starts the Canva OAuth flow on a remote server, the web UI
 * fetches GET /api/oauth/relay-token, which mints a short-lived bearer via
 * mint(userId). The user passes this bearer to the local Python helper script.
 * When the helper POSTs to /api/oauth/relay, the server consumes the bearer
 * via consume(token) → userId, then looks up the user's container and replays
 * the callback into it.
 *
 * Tokens are single-use (deleted on consume) and expire after TTL_MS.
 * A periodic sweep prunes expired entries to prevent unbounded growth.
 *
 * NOTE: This is an in-memory Map, sufficient for a single-process Next.js
 * MVP. If scaled to multiple processes or serverless, swap for a DB-backed
 * store (e.g. a relay_tokens table in SQLite).
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutes

interface RelayTokenEntry {
  userId: number;
  createdAt: number; // Date.now()
}

const store = new Map<string, RelayTokenEntry>();

// --- Sweep expired tokens every 60 seconds -------------------------------

let sweepTimer: ReturnType<typeof setInterval> | undefined;

function ensureSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of store) {
      if (now - entry.createdAt > TTL_MS) store.delete(token);
    }
    if (store.size === 0) {
      clearInterval(sweepTimer!);
      sweepTimer = undefined;
    }
  }, 60_000);
  // Don't prevent process exit
  if (typeof sweepTimer === "object" && "unref" in sweepTimer) {
    sweepTimer.unref();
  }
}

// --- Public API ---------------------------------------------------------

/** Mint a new single-use relay token for the given user. Returns the token string. */
export function mintRelayToken(userId: number): string {
  // 32 bytes of crypto-random hex = 64-char token.  Extremely unlikely to
  // collide even without checking — but we check anyway for safety.
  let token: string;
  do {
    token = randomBytes(32).toString("hex");
  } while (store.has(token));

  store.set(token, { userId, createdAt: Date.now() });
  ensureSweep();
  return token;
}

/**
 * Consume (use) a relay token. Returns the userId if valid and not yet used,
 * or null if the token is missing, expired, or already consumed.
 *
 * Tokens are single-use: a successful consume deletes the entry.
 */
export function consumeRelayToken(token: string): number | null {
  const entry = store.get(token);
  if (!entry) return null;

  // Check expiry
  if (Date.now() - entry.createdAt > TTL_MS) {
    store.delete(token);
    return null;
  }

  // Single-use: delete on consume
  store.delete(token);
  return entry.userId;
}
