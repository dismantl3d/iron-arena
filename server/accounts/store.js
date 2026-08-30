// AccountStore — the persistence backend, behind ONE small interface so the game
// server never touches SQL/files directly and the backend stays swappable:
//
//   openStore() -> { kind, getById(id), insert(account), save(account),
//                    count(), close() }
//
// WHY SQLite (better-sqlite3): it's free, $0 to run, a single local file, needs no
// server/daemon, and is fully transactional (ACID) — so concurrent multiplayer
// writes from ONE Node process can't corrupt data or race, unlike hand-rolled JSON
// files. It deploys as a single file and can later be swapped for Postgres/etc. by
// re-implementing this interface. Structured columns hold identity/xp/currency/
// loadout (queryable); naturally-collection-shaped data (unlock sets, claimed
// rewards, extensible stats) live in JSON columns, so adding a stat or unlock
// category needs no migration.
//
// If better-sqlite3 can't load (or IRON_DB=json), we fall back to a JSON-file store
// (atomic temp+rename writes — no partial-file corruption); if even that fails we
// use an in-memory store so the server NEVER crashes over storage (graceful).

import { normalize } from "./account.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(__dirname, "..", "data");

// account object <-> flat storage row (JSON columns for the collection-shaped data).
function toRow(a) {
  return {
    id: a.id, token_hash: a.tokenHash, token_salt: a.tokenSalt, display_name: a.displayName,
    created_at: a.createdAt, last_seen: a.lastSeen, xp: a.xp, currency: a.currency,
    claimed_rewards: JSON.stringify(a.claimedRewards || []),
    unlocks: JSON.stringify(a.unlocks || {}), loadout: JSON.stringify(a.loadout || {}), stats: JSON.stringify(a.stats || {}),
  };
}
function fromRow(r) {
  if (!r) return null;
  return normalize({
    id: r.id, tokenHash: r.token_hash, tokenSalt: r.token_salt, displayName: r.display_name,
    createdAt: r.created_at, lastSeen: r.last_seen, xp: r.xp, currency: r.currency,
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
    const cols = "(id,token_hash,token_salt,display_name,created_at,last_seen,xp,currency,claimed_rewards,unlocks,loadout,stats)";
    const vals = "(@id,@token_hash,@token_salt,@display_name,@created_at,@last_seen,@xp,@currency,@claimed_rewards,@unlocks,@loadout,@stats)";
    this._upsert = this.db.prepare(
      `INSERT INTO accounts ${cols} VALUES ${vals}
       ON CONFLICT(id) DO UPDATE SET token_hash=@token_hash,token_salt=@token_salt,display_name=@display_name,
         last_seen=@last_seen,xp=@xp,currency=@currency,claimed_rewards=@claimed_rewards,unlocks=@unlocks,loadout=@loadout,stats=@stats`,
    );
    this._get = this.db.prepare("SELECT * FROM accounts WHERE id = ?");
    this._count = this.db.prepare("SELECT COUNT(*) AS n FROM accounts");
  }
  getById(id) { return fromRow(this._get.get(id)); }
  insert(a) { this._upsert.run(toRow(a)); }
  save(a) { this._upsert.run(toRow(a)); }
  count() { return this._count.get().n; }
  close() { try { this.db.close(); } catch { /* ignore */ } }
}

class JsonStore {
  constructor(dir) {
    this.kind = "json";
    this.dir = dir;
    this.file = path.join(dir, "accounts.json");
    this.map = new Map();
    fs.mkdirSync(dir, { recursive: true });
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const r of raw) this.map.set(r.id, fromRow(r));
    } catch { /* fresh */ }
  }
  getById(id) { const a = this.map.get(id); return a ? normalize(structuredClone(a)) : null; }
  insert(a) { this.save(a); }
  save(a) { this.map.set(a.id, structuredClone(a)); this.#flush(); }
  count() { return this.map.size; }
  #flush() {
    const rows = [...this.map.values()].map(toRow);
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(rows)); // atomic: write temp then rename
    fs.renameSync(tmp, this.file);
  }
  close() { /* nothing to close */ }
}

class MemoryStore {
  constructor() { this.kind = "memory"; this.map = new Map(); }
  getById(id) { const a = this.map.get(id); return a ? normalize(structuredClone(a)) : null; }
  insert(a) { this.map.set(a.id, structuredClone(a)); }
  save(a) { this.map.set(a.id, structuredClone(a)); }
  count() { return this.map.size; }
  close() {}
}

// Open the best available store. `opts.kind` forces one ("sqlite"|"json"|"memory");
// otherwise honor IRON_DB, defaulting to SQLite and degrading gracefully.
export async function openStore(opts = {}) {
  const dir = opts.dir || process.env.IRON_DATA_DIR || DEFAULT_DIR;
  const want = opts.kind || process.env.IRON_DB || "sqlite";

  if (want === "memory") return new MemoryStore();
  if (want === "json") return new JsonStore(dir);

  // SQLite (default). Fall back if the native module is unavailable.
  try {
    const { default: Database } = await import("better-sqlite3");
    return new SqliteStore(Database, path.join(dir, "iron-arena.db"));
  } catch (e) {
    console.warn(`[iron-arena] SQLite unavailable (${e.message}); falling back to JSON store`);
    try { return new JsonStore(dir); }
    catch (e2) { console.warn(`[iron-arena] JSON store failed (${e2.message}); using in-memory store (not persistent)`); return new MemoryStore(); }
  }
}
