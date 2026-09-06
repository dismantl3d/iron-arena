// AccountService — the authoritative operations the game server calls. It owns the
// store and is the ONLY path that mutates persistent progression, so every change is
// server-side and validated. Clients present {accountId, token}; everything else
// (XP, currency, unlocks, stats) is decided here, never trusted from the client.

import { openStore } from "./store.js";
import { verifySecret } from "./auth.js";
import { createAccount, grantXp, recordMatch, applyLoadoutIndices, toProfileWire } from "./account.js";

export class AccountService {
  constructor(store) { this.store = store; }

  static async open(opts) { return new AccountService(await openStore(opts)); }

  get backend() { return this.store.kind; }

  // Identify a player. Returning clients present {accountId, token}; a fresh client
  // presents nothing (or an unknown id) and gets a NEW guest account. A KNOWN id
  // with a BAD token is rejected (never silently overwritten / spoofed).
  //   -> { ok:true, account, token?, isNew } | { ok:false, reason }
  //
  // `xp` (optional) carries the player's LOCAL progression so the account reflects
  // what they've actually unlocked — the game's progression currently lives in the
  // client profile (Iron Path XP), so without this a fresh guest account would own
  // nothing and validation would strip every equipped cosmetic/weapon down to the
  // defaults. New accounts are seeded with it; existing accounts carry forward to at
  // least that XP (max), never losing online-earned progress. (Full server-only,
  // tamper-proof progression is the FUTURE account work; this preserves the current
  // single-progression ownership behavior so equipped loadouts sync correctly.)
  login({ accountId, token, displayName, xp } = {}) {
    const seedXp = typeof xp === "number" && Number.isFinite(xp) && xp > 0 ? Math.floor(xp) : 0;
    if (accountId) {
      const existing = this.store.getById(accountId);
      if (existing) {
        if (!verifySecret(token, existing.tokenHash, existing.tokenSalt)) return { ok: false, reason: "bad-token" };
        if (seedXp > existing.xp) grantXp(existing, seedXp - existing.xp); // carry forward local progress
        existing.lastSeen = Date.now();
        this.store.save(existing);
        return { ok: true, account: existing, isNew: false };
      }
      // Unknown id -> fall through and mint a fresh account.
    }
    const { account, token: fresh } = createAccount({ displayName, seed: seedXp ? { ironPathXp: seedXp } : null });
    this.store.insert(account);
    return { ok: true, account, token: fresh, isNew: true };
  }

  getById(id) { return this.store.getById(id); }

  save(account) { account.lastSeen = Date.now(); this.store.save(account); }

  // Authoritatively award XP (+ any Iron Path rewards) and persist. Returns summary.
  awardXp(account, amount) {
    const summary = grantXp(account, amount);
    this.save(account);
    return summary;
  }

  // Record a finished match into persistent stats and persist.
  recordMatch(account, result) {
    recordMatch(account, result);
    this.save(account);
  }

  // Validate + equip a requested loadout (client indices) and persist. Returns the
  // applied INDICES (unowned picks fall back to the always-available defaults).
  setLoadout(account, requestedIndices) {
    const applied = applyLoadoutIndices(account, requestedIndices);
    this.save(account);
    return applied;
  }

  profile(account) { return toProfileWire(account); }

  close() { this.store.close(); }
}
