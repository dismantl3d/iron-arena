// Authentication primitives for accounts. Deliberately small and replaceable:
// today we use a TOKEN-based guest identity (no password UI) — the server mints a
// random secret token when an account is created, hands it to the client ONCE, and
// stores only a salted scrypt HASH of it (never the raw token, never a plaintext
// secret). Reconnecting clients present {accountId, token}; the server verifies the
// hash in constant time.
//
// This is structured so proper production auth (password login, OAuth, device
// migration) can slot in later behind the same createCredential / verify seam —
// e.g. hashing a user-chosen password instead of a generated token, unchanged
// storage shape. No external dependencies (node:crypto only).

import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from "node:crypto";

const SCRYPT_KEYLEN = 32;

export function newAccountId() {
  return "acct_" + randomUUID();
}

// A fresh secret token (the client's credential). 32 bytes -> 43-char base64url.
export function newToken() {
  return randomBytes(32).toString("base64url");
}

// Hash a secret (token or, later, a password) with a per-secret random salt.
// Returns { hash, salt } as hex strings — store these, never the secret itself.
export function hashSecret(secret) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(secret), salt, SCRYPT_KEYLEN);
  return { hash: hash.toString("hex"), salt: salt.toString("hex") };
}

// Constant-time verify of a presented secret against a stored {hash, salt}.
export function verifySecret(secret, hashHex, saltHex) {
  if (!secret || !hashHex || !saltHex) return false;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(String(secret), salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// --- password accounts + sessions (hosted-database accounts) ----------------------
// Passwords use scrypt via the ASYNC API so a login never blocks the game loop (the
// sync variants above are kept for the guest-token path / existing accounts).
import { scrypt as scryptCb, createHash } from "node:crypto";
import { promisify } from "node:util";
const scryptAsync = promisify(scryptCb);

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(String(password), salt, SCRYPT_KEYLEN);
  return { hash: hash.toString("hex"), salt: salt.toString("hex") };
}

export async function verifyPassword(password, hashHex, saltHex) {
  if (typeof password !== "string" || !hashHex || !saltHex) return false;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = await scryptAsync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Session tokens are high-entropy random secrets, so a plain SHA-256 is enough to store
// them safely (a DB leak can't be replayed as a login). Only the hash is persisted.
export const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");

// Username rules: 3–16 chars of letters/digits/underscore/hyphen. Case-insensitively unique.
export function validateUsername(u) {
  if (typeof u !== "string") return "username-invalid";
  const t = u.trim();
  if (t.length < 3 || t.length > 16 || !/^[A-Za-z0-9_-]+$/.test(t)) return "username-invalid";
  return null;
}
// Password rules: 8–128 chars (the cap bounds scrypt cost).
export function validatePassword(p) {
  if (typeof p !== "string" || p.length < 8 || p.length > 128) return "password-invalid";
  return null;
}
