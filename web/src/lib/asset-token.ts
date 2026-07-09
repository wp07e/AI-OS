import { createHmac, timingSafeEqual } from "node:crypto";
import { getAuthSecret } from "./auth";

/**
 * Signed tokens for the PUBLIC brand-asset proxy.
 *
 * The proxy (`/brand-assets/<assetId>`) is fetched by Canva's servers during
 * `upload-asset-from-url`, NOT by the user's browser — so it can't use the
 * session cookie. Instead each asset URL carries a signed token that embeds
 * the owning username + asset id, HMAC'd with the same stable secret as
 * sessions (so tokens survive restarts).
 *
 * Token shape: `<base64(json {u, a})>.<hex sig>`. The signature covers the
 * body so neither field can be tampered with.
 */

interface AssetTokenPayload {
  /** Owning username (resolves to the per-user container). */
  u: string;
  /** Asset id within that user's brand kit. */
  a: string;
}

/** Signs a payload → `<base64body>.<hexsig>`. */
function sign(payload: AssetTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", getAuthSecret()).update(body).digest("hex");
  return `${body}.${sig}`;
}

/** Verifies a token and returns its payload, or null if invalid/tampered. */
function verify(token: string): AssetTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac("sha256", getAuthSecret()).update(body).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AssetTokenPayload;
  } catch {
    return null;
  }
}

/** Mints a signed token for a (username, assetId) pair. */
export function signAssetToken(username: string, assetId: string): string {
  return sign({ u: username, a: assetId });
}

/** Verifies a token from the proxy query string. Returns the payload or null. */
export function verifyAssetToken(token: string): AssetTokenPayload | null {
  return verify(token);
}
