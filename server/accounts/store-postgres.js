// PostgresStore — the HOSTED, always-on account database (Neon / Supabase / any Postgres).
// Implements the same async AccountStore interface as the local stores, so the game
// server is unchanged apart from choosing it via IRON_DB=postgres + DATABASE_URL.
//
// Connection: a `pg` Pool (SSL on by default for hosted DBs; PGSSLMODE=disable for a
// local Postgres). A `pool` can be injected (tests use pg-mem).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export class UsernameTakenError extends Error {
  constructor() { super("username-taken"); this.code = "username-taken"; }
}

const COLS = "id,kind,username,username_lower,token_hash,token_salt,pass_hash,pass_salt,display_name,created_at,last_seen,xp,currency,claimed_rewards,unlocks,loadout,stats";

const toParams = (a) => [
  a.id, a.kind, a.username, a.usernameLower, a.tokenHash, a.tokenSalt, a.passHash, a.passSalt,
  a.displayName, a.createdAt, a.lastSeen, a.xp, a.currency,
  JSON.stringify(a.claimedRewards || []), JSON.stringify(a.unlocks || {}), JSON.stringify(a.loadout || {}), JSON.stringify(a.stats || {}),
];

const parse = (v, d) => (typeof v === "string" ? JSON.parse(v) : v ?? d);
const fromRow = (r) => !r ? null : ({
  id: r.id, kind: r.kind, username: r.username, usernameLower: r.username_lower,
  tokenHash: r.token_hash, tokenSalt: r.token_salt, passHash: r.pass_hash, passSalt: r.pass_salt,
  displayName: r.display_name, createdAt: Number(r.created_at), lastSeen: Number(r.last_seen),
  xp: r.xp, currency: r.currency,
  claimedRewards: parse(r.claimed_rewards, []), unlocks: parse(r.unlocks, {}), loadout: parse(r.loadout, {}), stats: parse(r.stats, {}),
});

export class PostgresStore {
  constructor(pool) {
    this.kind = "postgres";
    this.pool = pool;
  }

  // Create a store from DATABASE_URL (or an injected pool) and apply migrations.
  static async open({ url = process.env.DATABASE_URL, pool = null } = {}) {
    if (!pool) {
      if (!url) throw new Error("DATABASE_URL is required for IRON_DB=postgres");
      const pg = (await import("pg")).default;
      const ssl = process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false };
      pool = new pg.Pool({ connectionString: url, ssl, max: Number(process.env.PG_POOL_MAX || 5), connectionTimeoutMillis: 5000 });
      pool.on("error", (e) => console.warn("[iron-arena] postgres pool error:", e.message)); // idle-client errors must not crash
    }
    const store = new PostgresStore(pool);
    // A hosted DB being unreachable at boot must NOT take the game server down or silently swap
    // in a non-persistent store. Try once now; if it fails, every call retries on demand and
    // reports "unavailable" until the database is back (then migrations apply and it just works).
    try { await store.#ready(); }
    catch (e) { console.warn(`[iron-arena] postgres not reachable yet (${e.message}); accounts report "unavailable" until it is`); }
    return store;
  }

  async #ready() {
    if (this._ok) return;
    this._migrating ||= this.migrate().then(() => { this._ok = true; }).finally(() => { this._migrating = null; });
    await this._migrating;
  }

  // Apply any not-yet-applied .sql files in migrations/ (idempotent, in filename order).
  async migrate() {
    await this.pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)");
    const done = new Set((await this.pool.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")).sort()) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      for (const stmt of sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) {
        await this.pool.query(stmt);
      }
      await this.pool.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1,$2)", [f, Date.now()]);
    }
  }

  async getById(id) {
    await this.#ready();
    const r = await this.pool.query("SELECT * FROM accounts WHERE id = $1", [id]);
    return fromRow(r.rows[0]);
  }
  async getByUsername(lower) {
    await this.#ready();
    const r = await this.pool.query("SELECT * FROM accounts WHERE username_lower = $1", [lower]);
    return fromRow(r.rows[0]);
  }

  // Upsert (insert + save share one statement). A unique violation on the username index
  // surfaces as UsernameTakenError so callers can report "taken" without a race.
  async #upsert(a) {
    await this.#ready();
    const ph = Array.from({ length: 17 }, (_, i) => `$${i + 1}`).join(",");
    const sql = `INSERT INTO accounts (${COLS}) VALUES (${ph})
      ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind, username=EXCLUDED.username, username_lower=EXCLUDED.username_lower,
        token_hash=EXCLUDED.token_hash, token_salt=EXCLUDED.token_salt, pass_hash=EXCLUDED.pass_hash, pass_salt=EXCLUDED.pass_salt,
        display_name=EXCLUDED.display_name, last_seen=EXCLUDED.last_seen, xp=EXCLUDED.xp, currency=EXCLUDED.currency,
        claimed_rewards=EXCLUDED.claimed_rewards, unlocks=EXCLUDED.unlocks, loadout=EXCLUDED.loadout, stats=EXCLUDED.stats`;
    try {
      await this.pool.query(sql, toParams(a));
    } catch (e) {
      if (e.code === "23505" || /unique|duplicate/i.test(e.message || "")) throw new UsernameTakenError();
      throw e;
    }
  }
  insert(a) { return this.#upsert(a); }
  save(a) { return this.#upsert(a); }

  async count() { await this.#ready(); return Number((await this.pool.query("SELECT COUNT(*) AS n FROM accounts")).rows[0].n); }

  // --- sessions (hashed tokens only) ---
  async createSession(tokenHash, accountId, expiresAt) {
    await this.#ready();
    await this.pool.query("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1,$2,$3)", [tokenHash, accountId, expiresAt]);
  }
  async getSession(tokenHash) {
    await this.#ready();
    const r = await this.pool.query("SELECT account_id, expires_at FROM sessions WHERE token_hash = $1", [tokenHash]);
    return r.rows[0] ? { accountId: r.rows[0].account_id, expiresAt: Number(r.rows[0].expires_at) } : null;
  }
  async deleteSession(tokenHash) { await this.#ready(); await this.pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]); }
  async pruneSessions() { await this.#ready(); await this.pool.query("DELETE FROM sessions WHERE expires_at < $1", [Date.now()]); }

  async ping() { await this.pool.query("SELECT 1"); }
  async close() { try { await this.pool.end(); } catch { /* ignore */ } }
}
