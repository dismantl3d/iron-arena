// AccountService — the authoritative operations the game server calls. It owns the store and is
// the ONLY path that mutates persistent progression, so every change is server-side and
// validated. Clients prove who they are (guest token / password / session token); everything
// else (XP, currency, unlocks, stats) is decided here, never trusted from the client.
//
// Hosted-database design (the DB is remote and async, the match loop is synchronous):
//  • AUTH is async (DB reads, scrypt) and returns { ok:false, reason } — a DB outage surfaces
//    as reason "unavailable" and never throws into the server.
//  • A logged-in account lives in an in-memory CACHE shared by every socket of that player
//    (menu connection + match connection hold refs to the SAME object) → no lost updates and
//    no DB round-trip in the match loop.
//  • Mutations (awardXp / recordMatch / setLoadout …) are SYNCHRONOUS in memory and enqueue a
//    coalesced, serialized, retrying write-behind to the store. flush()/flushAll() await them
//    (disconnect, shutdown).

import { openStore, UsernameTakenError } from "./store.js";
import { verifyPassword, hashPassword, newToken, hashToken, validateUsername, validatePassword } from "./auth.js";
import { createAccount, grantXp, recordMatch, applyLoadoutIndices, toProfileWire, setDisplayName, devUnlockAll } from "./account.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;

// A fixed valid hash, so an unknown username costs the same scrypt work as a wrong password
// (no username-enumeration via timing).
const DUMMY = { hash: "00".repeat(32), salt: "11".repeat(16) };

export class AccountService {
  constructor(store, opts = {}) {
    this.store = store;
    this.active = new Map(); // accountId -> { account, refs }
    this.pending = new Map(); // accountId -> { again, p } (in-flight write-behind)
    this.failed = new Map(); // accountId -> account (writes that exhausted retries; retried later)
    this.sessionTtl = (opts.sessionTtlDays ?? Number(process.env.SESSION_TTL_DAYS || 30)) * DAY;
    // Dev unlock (server twin of the TEST button): on unless production, or forced by env.
    const env = process.env.IRON_DEV_UNLOCK;
    this.devUnlockAllowed = opts.devUnlock ?? (env === "1" || (process.env.NODE_ENV !== "production" && env !== "0"));
    this._retry = setInterval(() => { for (const a of this.failed.values()) this.#schedule(a); }, 10000);
    this._prune = setInterval(() => this.store.pruneSessions().catch(() => {}), 3600000);
    this._retry.unref?.(); this._prune.unref?.();
  }

  static async open(opts) { return new AccountService(await openStore(opts), opts); }
  get backend() { return this.store.kind; }

  // --- cache / refs ---------------------------------------------------------
  #attach(account) {
    const e = this.active.get(account.id);
    if (e) { e.refs++; return e.account; } // reuse the live object (other sockets of this player)
    this.active.set(account.id, { account, refs: 1 });
    return account;
  }
  // Drop one socket's reference; when the last goes, flush then evict from the cache.
  async release(account) {
    if (!account) return;
    const e = this.active.get(account.id);
    if (!e) return;
    e.refs--;
    if (e.refs <= 0) {
      await this.flush(account.id);
      const again = this.active.get(account.id);
      if (again && again.refs <= 0) this.active.delete(account.id);
    }
  }

  // --- write-behind ---------------------------------------------------------
  save(account) { account.lastSeen = Date.now(); if (account.ephemeral) return; this.#schedule(account); }

  #schedule(account) {
    const id = account.id;
    let q = this.pending.get(id);
    if (q) { q.again = true; return; } // coalesce: one more write after the current one
    q = { again: false, p: null };
    this.pending.set(id, q);
    q.p = (async () => {
      try { do { q.again = false; await this.#writeRetry(account); } while (q.again); }
      finally { this.pending.delete(id); }
    })();
  }

  async #writeRetry(account) {
    let delay = 250;
    for (let i = 0; i < 5; i++) {
      try { await this.store.save(account); this.failed.delete(account.id); return; }
      catch (e) {
        if (i === 4) { console.error(`[iron-arena] account save failed for ${account.id} (will retry): ${e.message}`); this.failed.set(account.id, account); return; }
        await sleep(delay); delay *= 2;
      }
    }
  }

  // Wait for an account's pending writes (and re-attempt a previously failed one once).
  async flush(id) {
    if (this.failed.has(id)) this.#schedule(this.failed.get(id));
    while (this.pending.has(id)) await this.pending.get(id).p;
  }
  async flushAll() {
    for (const { account } of this.active.values()) this.#schedule(account);
    for (const a of this.failed.values()) this.#schedule(a);
    while (this.pending.size) await Promise.all([...this.pending.values()].map((q) => q.p));
  }

  // --- auth -----------------------------------------------------------------
  // Guest identity: {accountId, token} (token issued once at creation). A fresh/unknown id
  // mints a NEW guest account. A KNOWN id with a bad token is rejected (never spoofed).
  // Registered accounts can't use the guest path (they log in with a password / session).
  async loginGuest({ accountId, token, displayName } = {}) {
    try {
      if (accountId) {
        const existing = this.active.get(accountId)?.account || (await this.store.getById(accountId));
        if (existing) {
          if (existing.kind === "registered") return { ok: false, reason: "use-login" };
          if (!(await verifyPassword(token, existing.tokenHash, existing.tokenSalt))) return { ok: false, reason: "bad-token" };
          existing.lastSeen = Date.now();
          const account = this.#attach(existing);
          this.save(account);
          return { ok: true, account, isNew: false };
        }
      }
      const { account: fresh, token: guestToken } = createAccount({ displayName });
      await this.store.insert(fresh);
      return { ok: true, account: this.#attach(fresh), token: guestToken, isNew: true };
    } catch (e) {
      const r = this.#fail(e);
      if (r.reason !== "unavailable") return r;
      // Database unreachable: degrade to a playable, NON-persistent guest instead of refusing
      // the connection (progress isn't saved this session; the stored identity is untouched).
      const { account } = createAccount({ displayName });
      account.ephemeral = true;
      return { ok: true, account: this.#attach(account), isNew: true, ephemeral: true };
    }
  }

  // Create a username+password account. If `current` is a guest account, UPGRADE it in place
  // (keeping its progress); otherwise create a new registered account.
  async register(current, { username, password } = {}) {
    const bad = validateUsername(username) || validatePassword(password);
    if (bad) return { ok: false, reason: bad };
    const name = username.trim();
    const lower = name.toLowerCase();
    try {
      const owner = await this.store.getByUsername(lower);
      if (owner && owner.id !== current?.id) return { ok: false, reason: "username-taken" };
      const { hash, salt } = await hashPassword(password);

      let account;
      if (current && current.kind === "guest") {
        // Build the change on a copy; commit to the live (shared) object only once saved.
        const candidate = structuredClone(current);
        this.#applyRegistration(candidate, name, lower, hash, salt);
        await this.store.save(candidate);
        this.#applyRegistration(current, name, lower, hash, salt);
        account = current;
      } else {
        const { account: fresh } = createAccount({ displayName: name });
        this.#applyRegistration(fresh, name, lower, hash, salt);
        await this.store.insert(fresh);
        account = this.#attach(fresh);
      }
      return { ok: true, account, sessionToken: await this.#newSession(account.id) };
    } catch (e) { return this.#fail(e); }
  }

  #applyRegistration(a, name, lower, hash, salt) {
    a.kind = "registered"; a.username = name; a.usernameLower = lower;
    a.passHash = hash; a.passSalt = salt;
    a.tokenHash = hashToken(newToken()); a.tokenSalt = ""; // invalidate any old guest token
    delete a.ephemeral; // an upgraded degraded-mode guest becomes a real, persisted account
    if (!a.displayName) a.displayName = name;
  }

  async loginPassword({ username, password } = {}) {
    if (typeof username !== "string" || typeof password !== "string" || password.length > 128) return { ok: false, reason: "bad-credentials" };
    try {
      const row = await this.store.getByUsername(username.trim().toLowerCase());
      const ok = await verifyPassword(password, row?.passHash ?? DUMMY.hash, row?.passSalt ?? DUMMY.salt);
      if (!row || !row.passHash || !ok) return { ok: false, reason: "bad-credentials" }; // same answer for unknown user / wrong password
      const account = this.#attach(this.active.get(row.id)?.account || row);
      this.save(account);
      return { ok: true, account, sessionToken: await this.#newSession(account.id) };
    } catch (e) { return this.#fail(e); }
  }

  // Resume a logged-in session (auto-login after reload / on the match socket).
  async resume(sessionToken) {
    if (typeof sessionToken !== "string" || sessionToken.length < 20) return { ok: false, reason: "bad-session" };
    try {
      const h = hashToken(sessionToken);
      const s = await this.store.getSession(h);
      if (!s) return { ok: false, reason: "bad-session" };
      if (s.expiresAt <= Date.now()) { await this.store.deleteSession(h); return { ok: false, reason: "bad-session" }; }
      const row = this.active.get(s.accountId)?.account || (await this.store.getById(s.accountId));
      if (!row) return { ok: false, reason: "bad-session" };
      return { ok: true, account: this.#attach(row), sessionToken };
    } catch (e) { return this.#fail(e); }
  }

  async logout(sessionToken) {
    try { if (typeof sessionToken === "string") await this.store.deleteSession(hashToken(sessionToken)); } catch { /* best effort */ }
  }

  async #newSession(accountId) {
    const token = newToken();
    await this.store.createSession(hashToken(token), accountId, Date.now() + this.sessionTtl);
    return token;
  }

  #fail(e) {
    if (e instanceof UsernameTakenError) return { ok: false, reason: "username-taken" };
    console.warn(`[iron-arena] account backend error: ${e.message}`);
    return { ok: false, reason: "unavailable" };
  }

  // --- progression (synchronous in memory + write-behind) --------------------
  awardXp(account, amount) { const s = grantXp(account, amount); this.save(account); return s; }
  recordMatch(account, result) { recordMatch(account, result); this.save(account); }
  // Validate + equip a requested loadout (client indices). Unowned picks fall back to defaults.
  setLoadout(account, requested) { const applied = applyLoadoutIndices(account, requested); this.save(account); return applied; }
  setDisplayName(account, name) { if (setDisplayName(account, name)) this.save(account); }
  // DEV ONLY (see devUnlockAllowed): unlock everything, like the TEST button.
  devUnlock(account) {
    if (!this.devUnlockAllowed) return false;
    devUnlockAll(account); this.save(account); return true;
  }
  profile(account) { return toProfileWire(account); }

  async health() { await this.store.ping(); }

  async close() {
    clearInterval(this._retry); clearInterval(this._prune);
    await this.flushAll();
    await this.store.close();
  }
}
