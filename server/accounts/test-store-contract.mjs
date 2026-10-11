// Store contract test: the SAME assertions run against every AccountStore backend, so a
// hosted Postgres behaves identically to the local stores. Backends: memory, json, sqlite,
// postgres (real PostgresStore code on pg-mem — an in-memory Postgres emulator), and a REAL
// Postgres when IRON_TEST_DATABASE_URL is set (e.g. a throwaway Neon branch).
//   node server/accounts/test-store-contract.mjs

import { openStore, UsernameTakenError } from "./store.js";
import { PostgresStore } from "./store-postgres.js";
import { createAccount } from "./account.js";
import { hashToken } from "./auth.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { newDb } from "pg-mem";

const R = {};
let failed = 0;
const check = (k, ok, detail = "") => { R[k] = ok ? true : `FAIL ${detail}`; if (!ok) failed++; };

function reg(name, n) {
  const { account } = createAccount({ displayName: name });
  account.kind = "registered"; account.username = n; account.usernameLower = n.toLowerCase();
  return account;
}

async function suite(label, openFn, reopenFn) {
  const p = (s) => `${label}:${s}`;
  const tag = Math.random().toString(36).slice(2, 8); // unique names so a shared real DB can't collide
  let store = await openFn();

  // roundtrip incl. JSON-shaped fields
  const a = reg("Alice", `Alice_${tag}`);
  a.xp = 1234; a.currency = 77; a.claimedRewards = [1, 2, 3]; a.stats.matchesPlayed = 4;
  await store.insert(a);
  const got = await store.getById(a.id);
  check(p("roundtrip"), got && got.xp === 1234 && got.currency === 77 && got.claimedRewards.length === 3 && got.stats.matchesPlayed === 4 && got.unlocks.colors.length >= 1, JSON.stringify(got)?.slice(0, 120));
  check(p("username_lookup_case_insensitive"), (await store.getByUsername(`alice_${tag}`))?.id === a.id);
  check(p("missing_is_null"), (await store.getById("acct_nope")) === null && (await store.getByUsername("nobody_" + tag)) === null);

  // save updates
  a.xp = 5000; await store.save(a);
  check(p("save_updates"), (await store.getById(a.id)).xp === 5000);

  // unique username (case-insensitive) + guests with no username coexist
  const dup = reg("Dup", `ALICE_${tag}`);
  let taken = false;
  try { await store.insert(dup); } catch (e) { taken = e instanceof UsernameTakenError; }
  check(p("unique_username_enforced"), taken);
  const g1 = createAccount({ displayName: "g1" }).account, g2 = createAccount({ displayName: "g2" }).account;
  await store.insert(g1); await store.insert(g2);
  check(p("guests_coexist"), (await store.getById(g1.id)) && (await store.getById(g2.id)));

  // concurrent saves converge to the last value
  await Promise.all(Array.from({ length: 20 }, (_, i) => { const c = structuredClone(a); c.xp = 6000 + i; return store.save(c); }));
  check(p("concurrent_saves_ok"), (await store.getById(a.id)).xp >= 6000);

  // sessions
  const th = hashToken("tok-" + tag);
  await store.createSession(th, a.id, Date.now() + 60000);
  check(p("session_get"), (await store.getSession(th))?.accountId === a.id);
  await store.createSession(hashToken("old-" + tag), a.id, Date.now() - 1000);
  await store.pruneSessions();
  check(p("session_prune_expired"), (await store.getSession(hashToken("old-" + tag))) === null && (await store.getSession(th)) !== null);
  await store.deleteSession(th);
  check(p("session_delete"), (await store.getSession(th)) === null);

  check(p("count"), (await store.count()) >= 3);
  await store.ping();

  // persistence across reopen
  if (reopenFn) {
    await store.close();
    store = await reopenFn();
    check(p("persists_across_reopen"), (await store.getById(a.id))?.xp >= 6000 && (await store.getByUsername(`alice_${tag}`))?.id === a.id);
  }
  await store.close();
}

(async () => {
  const dir = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `iron-store-${n}-`));

  await suite("memory", () => openStore({ kind: "memory" }), null);
  const jd = dir("json");
  await suite("json", () => openStore({ kind: "json", dir: jd }), () => openStore({ kind: "json", dir: jd }));
  const sd = dir("sqlite");
  await suite("sqlite", () => openStore({ kind: "sqlite", dir: sd }), () => openStore({ kind: "sqlite", dir: sd }));

  // Postgres on pg-mem: one in-memory database, re-"opened" through a fresh PostgresStore on the same pool.
  const mem = newDb({ noAstCoverageCheck: true }); // emulator quirk: inline constraints inside IF NOT EXISTS
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  await suite("postgres(pg-mem)", () => PostgresStore.open({ pool }), () => PostgresStore.open({ pool }));

  // Optional: a REAL hosted/local Postgres.
  if (process.env.IRON_TEST_DATABASE_URL) {
    const url = process.env.IRON_TEST_DATABASE_URL;
    await suite("postgres(real)", () => PostgresStore.open({ url }), () => PostgresStore.open({ url }));
  } else {
    R["postgres(real)"] = "SKIPPED (set IRON_TEST_DATABASE_URL to also run against a real Postgres)";
  }

  for (const d of [jd, sd]) fs.rmSync(d, { recursive: true, force: true });
  console.log(JSON.stringify(R, null, 2));
  if (failed) { console.log(`\n${failed} FAILURE(S)`); process.exit(1); }
  console.log("\nALL STORE CONTRACT TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST CRASHED:", e); process.exit(1); });
