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
