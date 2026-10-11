// AccountStore — the persistence backend, behind ONE small ASYNC interface so the game
// server never touches SQL/files directly and the backend stays swappable:
//
//   openStore() -> {
//     kind, getById(id), getByUsername(lower), insert(account), save(account),
//     count(), createSession(hash, accountId, expiresAt), getSession(hash),
//     deleteSession(hash), pruneSessions(), ping(), close()
//   }   (every method returns a Promise)
//
// Backends:
//   postgres — HOSTED, always-on (Neon / Supabase / any Postgres). Production. Select with
//              IRON_DB=postgres + DATABASE_URL.
//   sqlite   — single local file (better-sqlite3, ACID). Local development default.
//   json     — atomic JSON file fallback if the native module can't load.
//   memory   — non-persistent (tests, last-resort fallback so the server never crashes).
//
// The local stores are synchronous underneath and wrapped in async methods; Postgres is
// natively async. AccountService (service.js) is the only caller.

import { normalize } from "./account.js";
import { UsernameTakenError, PostgresStore } from "./store-postgres.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export { UsernameTakenError };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(__dirname, "..", "data");

// account object <-> flat row (JSON text columns for the collection-shaped data).
function toRow(a) {
  return {
    id: a.id, kind: a.kind || "guest", username: a.username ?? null, username_lower: a.usernameLower ?? null,
    token_hash: a.tokenHash, token_salt: a.tokenSalt, pass_hash: a.passHash ?? null, pass_salt: a.passSalt ?? null,
    display_name: a.displayName, created_at: a.createdAt, last_seen: a.lastSeen, xp: a.xp, currency: a.currency,
    claimed_rewards: JSON.stringify(a.claimedRewards || []),
    unlocks: JSON.stringify(a.unlocks || {}), loadout: JSON.stringify(a.loadout || {}), stats: JSON.stringify(a.stats || {}),
  };
}
function fromRow(r) {
  if (!r) return null;
  return normalize({
    id: r.id, kind: r.kind, username: r.username, usernameLower: r.username_lower,
    tokenHash: r.token_hash, tokenSalt: r.token_salt, passHash: r.pass_hash, passSalt: r.pass_salt,
    displayName: r.display_name, createdAt: r.created_at, lastSeen: r.last_seen, xp: r.xp, currency: r.currency,
    claimedRewards: JSON.parse(r.claimed_rewards || "[]"),
    unlocks: JSON.parse(r.unlocks || "{}"), loadout: JSON.parse(r.loadout || "{}"), stats: JSON.parse(r.stats || "{}"),
  });
}

class SqliteStore {
  constructor(Database, dbPath) {
    this.kind = "sqlite";
    this.path = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL"); // concurrent-read friendly, crash-safe
    this.db.exec(`CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, token_salt TEXT NOT NULL,
      display_name TEXT, created_at INTEGER, last_seen INTEGER, xp INTEGER, currency INTEGER,
      claimed_rewards TEXT, unlocks TEXT, loadout TEXT, stats TEXT
    )`);
    // Upgrade older local DBs in place (columns added by the hosted-accounts work).
    const have = new Set(this.db.prepare("PRAGMA table_info(accounts)").all().map((c) => c.name));
    for (const [col, ddl] of [["kind", "TEXT DEFAULT 'guest'"], ["username", "TEXT"], ["username_lower", "TEXT"], ["pass_hash", "TEXT"], ["pass_salt", "TEXT"]]) {
      if (!have.has(col)) this.db.exec(`ALTER TABLE accounts ADD COLUMN ${col} ${ddl}`);
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_lower_uq ON accounts (username_lower)");
    this.db.exec("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL)");

    const cols = "id,kind,username,username_lower,token_hash,token_salt,pass_hash,pass_salt,display_name,created_at,last_seen,xp,currency,claimed_rewards,unlocks,loadout,stats";
    const vals = cols.split(",").map((c) => "@" + c).join(",");
    this._upsert = this.db.prepare(
      `INSERT INTO accounts (${cols}) VALUES (${vals})
       ON CONFLICT(id) DO UPDATE SET kind=@kind,username=@username,username_lower=@username_lower,token_hash=@token_hash,token_salt=@token_salt,
         pass_hash=@pass_hash,pass_salt=@pass_salt,display_name=@display_name,last_seen=@last_seen,xp=@xp,currency=@currency,
         claimed_rewards=@claimed_rewards,unlocks=@unlocks,loadout=@loadout,stats=@stats`,
    );
    this._get = this.db.prepare("SELECT * FROM accounts WHERE id = ?");
    this._byName = this.db.prepare("SELECT * FROM accounts WHERE username_lower = ?");
    this._count = this.db.prepare("SELECT COUNT(*) AS n FROM accounts");
    this._sIns = this.db.prepare("INSERT INTO sessions (token_hash,account_id,expires_at) VALUES (?,?,?)");
    this._sGet = this.db.prepare("SELECT account_id, expires_at FROM sessions WHERE token_hash = ?");
    this._sDel = this.db.prepare("DELETE FROM sessions WHERE token_hash = ?");
    this._sPrune = this.db.prepare("DELETE FROM sessions WHERE expires_at < ?");
  }
  #write(a) {
    try { this._upsert.run(toRow(a)); }
    catch (e) { if (String(e.code).startsWith("SQLITE_CONSTRAINT")) throw new UsernameTakenError(); throw e; }
  }
  async getById(id) { return fromRow(this._get.get(id)); }
  async getByUsername(lower) { return fromRow(this._byName.get(lower)); }
  async insert(a) { this.#write(a); }
  async save(a) { this.#write(a); }
  async count() { return this._count.get().n; }
  async createSession(h, id, exp) { this._sIns.run(h, id, exp); }
  async getSession(h) { const r = this._sGet.get(h); return r ? { accountId: r.account_id, expiresAt: r.expires_at } : null; }
  async deleteSession(h) { this._sDel.run(h); }
  async pruneSessions() { this._sPrune.run(Date.now()); }
  async ping() { this._count.get(); }
  async close() { try { this.db.close(); } catch { /* ignore */ } }
}

// Shared logic for the two non-SQL stores (account Map + username index + sessions Map).
class MapStoreBase {
  constructor() { this.map = new Map(); this.names = new Map(); this.sessions = new Map(); }
  #claim(a) {
    if (a.usernameLower) {
      const owner = this.names.get(a.usernameLower);
      if (owner && owner !== a.id) throw new UsernameTakenError();
    }
    for (const [n, id] of this.names) if (id === a.id && n !== a.usernameLower) this.names.delete(n);
    if (a.usernameLower) this.names.set(a.usernameLower, a.id);
  }
  async getById(id) { const a = this.map.get(id); return a ? normalize(structuredClone(a)) : null; }
  async getByUsername(lower) { const id = this.names.get(lower); return id ? this.getById(id) : null; }
  async insert(a) { await this.save(a); }
  async save(a) { this.#claim(a); this.map.set(a.id, structuredClone(a)); this._flush?.(); }
  async count() { return this.map.size; }
  async createSession(h, id, exp) { this.sessions.set(h, { accountId: id, expiresAt: exp }); this._flush?.(); }
  async getSession(h) { return this.sessions.get(h) ?? null; }
  async deleteSession(h) { this.sessions.delete(h); this._flush?.(); }
  async pruneSessions() { const now = Date.now(); for (const [h, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(h); }
  async ping() {}
  async close() {}
}

class JsonStore extends MapStoreBase {
  constructor(dir) {
    super();
    this.kind = "json";
    this.file = path.join(dir, "accounts.json");
    this.sfile = path.join(dir, "sessions.json");
    fs.mkdirSync(dir, { recursive: true });
    try { for (const r of JSON.parse(fs.readFileSync(this.file, "utf8"))) { const a = fromRow(r); this.map.set(a.id, a); if (a.usernameLower) this.names.set(a.usernameLower, a.id); } } catch { /* fresh */ }
    try { for (const [h, s] of Object.entries(JSON.parse(fs.readFileSync(this.sfile, "utf8")))) this.sessions.set(h, s); } catch { /* fresh */ }
  }
  _flush() {
    // atomic: write temp then rename (no partial-file corruption)
    for (const [file, data] of [[this.file, [...this.map.values()].map(toRow)], [this.sfile, Object.fromEntries(this.sessions)]]) {
      fs.writeFileSync(file + ".tmp", JSON.stringify(data));
      fs.renameSync(file + ".tmp", file);
    }
  }
}

class MemoryStore extends MapStoreBase {
  constructor() { super(); this.kind = "memory"; }
}

// Open the best available store. `opts.kind` forces one; otherwise honor IRON_DB,
// defaulting to local SQLite and degrading gracefully. postgres is NOT silently
// downgraded: a configured hosted DB that is unreachable is a deploy error worth failing on.
export async function openStore(opts = {}) {
  const dir = opts.dir || process.env.IRON_DATA_DIR || DEFAULT_DIR;
  const want = opts.kind || process.env.IRON_DB || (process.env.DATABASE_URL ? "postgres" : "sqlite");

  if (want === "postgres") return PostgresStore.open({ url: opts.url, pool: opts.pool });
  if (want === "memory") return new MemoryStore();
  if (want === "json") return new JsonStore(dir);

  try {
    const { default: Database } = await import("better-sqlite3");
    return new SqliteStore(Database, path.join(dir, "iron-arena.db"));
  } catch (e) {
    console.warn(`[iron-arena] SQLite unavailable (${e.message}); falling back to JSON store`);
    try { return new JsonStore(dir); }
    catch (e2) { console.warn(`[iron-arena] JSON store failed (${e2.message}); using in-memory store (not persistent)`); return new MemoryStore(); }
  }
}
