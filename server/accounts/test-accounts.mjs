// Account-service tests (async, hosted-DB design). Runs the whole suite against SQLite, the
// JSON fallback and Postgres (the real PostgresStore on pg-mem). Covers: creation defaults,
// persistence across a store reopen, Iron Path unlocks/currency (no duplicate claims),
// loadout validation, guest token auth, REGISTER / password LOGIN / SESSION resume / logout,
// guest→registered upgrade (keeps progress), username rules + uniqueness, no user enumeration,
// shared in-memory account per player, write-behind retry, DB-outage degrade, dev-unlock gating.
//   node server/accounts/test-accounts.mjs

import { AccountService } from "./service.js";
import { PostgresStore } from "./store-postgres.js";
import { openStore } from "./store.js";
import { idFor, indexFor } from "./ids.js";
import { levelForXp } from "../../src/game/IronPath.js";
import { newDb } from "pg-mem";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const R = {};
let failed = 0;
const check = (k, ok, detail = "") => { R[k] = ok ? true : `FAIL ${detail}`; if (!ok) failed++; };
const eq = (k, got, want) => check(k, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);

async function run(label, makeStore) {
  const p = (s) => `${label}:${s}`;
  let svc = new AccountService(await makeStore(), { devUnlock: false });
  const tag = Math.random().toString(36).slice(2, 7);

  // ---- guest creation defaults ----
  const g = await svc.loginGuest({ displayName: "Tanky" });
  check(p("guest_created"), g.ok && g.isNew && g.account.id.startsWith("acct_") && g.account.kind === "guest");
  check(p("guest_token_issued_once"), typeof g.token === "string" && g.token.length > 20);
  const w = svc.profile(g.account);
  eq(p("default_level_1"), w.level, 1);
  eq(p("default_loadout"), w.loadout, { weapon: 0, cosmetic: 0, wrap: 0, trail: 0, killFx: 0, title: 0 }); // Blue / Standard / none-equipped allowed
  check(p("blue_standard_owned"), w.unlocks.colors.includes(0) && w.unlocks.weapons.includes(0));
  const gid = g.account.id, gtoken = g.token;

  // ---- XP / unlocks / currency / persistence across reopen ----
  svc.awardXp(g.account, 3000); // -> level 6
  eq(p("level_6"), levelForXp(g.account.xp), 6);
  check(p("dual_barrel_unlocked"), g.account.unlocks.weapons.includes(idFor("weapons", 1)));
  const cur = g.account.currency;
  svc.awardXp(g.account, 0);
  eq(p("no_duplicate_currency"), g.account.currency, cur);
  eq(p("loadout_equips_owned"), svc.setLoadout(g.account, { weapon: 1 }).weapon, 1);
  eq(p("loadout_rejects_unowned"), svc.setLoadout(g.account, { weapon: 10, cosmetic: 3 }).weapon, 0);
  svc.setLoadout(g.account, { weapon: 1 });
  await svc.flushAll();
  await svc.close();
  svc = new AccountService(await makeStore(), { devUnlock: false });

  // guest returns with the token → same account + progress; bad token rejected
  const back = await svc.loginGuest({ accountId: gid, token: gtoken });
  check(p("guest_returns_same_account"), back.ok && !back.isNew && back.account.id === gid && back.account.xp === 3000);
  eq(p("loadout_persisted"), indexFor("weapons", back.account.loadout.weapons), 1);
  check(p("bad_guest_token_rejected"), (await svc.loginGuest({ accountId: gid, token: "forged" })).reason === "bad-token");

  // ---- register: upgrades the guest in place (progress kept) ----
  const name = `Pilot_${tag}`;
  check(p("register_validates_username"), (await svc.register(back.account, { username: "a!", password: "longenough1" })).reason === "username-invalid");
  check(p("register_validates_password"), (await svc.register(back.account, { username: name, password: "short" })).reason === "password-invalid");
  const reg = await svc.register(back.account, { username: name, password: "correct horse 9" });
  check(p("guest_upgraded"), reg.ok && reg.account.id === gid && reg.account.kind === "registered" && reg.account.xp === 3000 && typeof reg.sessionToken === "string");
  check(p("password_not_stored_plaintext"), reg.account.passHash && !JSON.stringify(reg.account).includes("correct horse"));
  check(p("old_guest_token_dead_after_register"), (await svc.loginGuest({ accountId: gid, token: gtoken })).reason === "use-login");

  // unique + case-insensitive username
  const dup = await svc.register(null, { username: name.toUpperCase(), password: "another pass 12" });
  eq(p("username_taken"), dup.reason, "username-taken");

  // ---- password login / sessions (a "new device" has nothing but the password) ----
  await svc.flushAll();
  await svc.release(back.account); await svc.release(back.account); // drop socket refs so we reload from the DB
  await svc.flushAll();
  const li = await svc.loginPassword({ username: name.toLowerCase(), password: "correct horse 9" });
  check(p("login_ok_progress_intact"), li.ok && li.account.id === gid && li.account.xp === 3000 && li.account.unlocks.weapons.includes(idFor("weapons", 1)));
  const bad1 = await svc.loginPassword({ username: name, password: "wrong password!" });
  const bad2 = await svc.loginPassword({ username: "nobody_" + tag, password: "wrong password!" });
  check(p("wrong_password_and_unknown_user_look_identical"), bad1.reason === "bad-credentials" && bad2.reason === "bad-credentials");

  const rs = await svc.resume(li.sessionToken);
  check(p("session_resume_ok"), rs.ok && rs.account.id === gid);
  check(p("forged_session_rejected"), (await svc.resume("x".repeat(43))).reason === "bad-session");
  check(p("shared_account_object_across_sockets"), rs.account === li.account); // menu socket + match socket → same object
  await svc.logout(li.sessionToken);
  check(p("logout_kills_session"), (await svc.resume(li.sessionToken)).reason === "bad-session");

  // expired session
  const tinyTtl = new AccountService(await makeStore(), { sessionTtlDays: 0 });
  const t = await tinyTtl.loginPassword({ username: name, password: "correct horse 9" });
  check(p("expired_session_rejected"), t.ok && (await tinyTtl.resume(t.sessionToken)).reason === "bad-session");
  await tinyTtl.close();

  // ---- isolation: two accounts don't affect each other ----
  const other = await svc.loginGuest({ displayName: "Other" });
  svc.awardXp(other.account, 9000);
  check(p("accounts_isolated"), li.account.xp === 3000 && other.account.id !== gid);

  // ---- dev unlock is gated ----
  check(p("dev_unlock_off_by_default_in_test"), svc.devUnlock(other.account) === false && other.account.xp === 9000);
  const devSvc = new AccountService(await makeStore(), { devUnlock: true });
  const d = await devSvc.loginGuest({ displayName: "Dev" });
  check(p("dev_unlock_when_enabled"), devSvc.devUnlock(d.account) && levelForXp(d.account.xp) === 60 && d.account.unlocks.weapons.length === 11);
  await devSvc.close();

  await svc.close();
}

// ---- write-behind retry + outage degrade (store wrapper that can fail) ----
async function resilience() {
  const mem = await openStore({ kind: "memory" });
  let down = false, saves = 0;
  const flaky = new Proxy(mem, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== "function") return v;
      return (...a) => { if (down && k !== "close") return Promise.reject(new Error("db down")); if (k === "save") saves++; return v.apply(t, a); };
    },
  });
  const svc = new AccountService(flaky, { devUnlock: false });
  const g = await svc.loginGuest({ displayName: "Res" });
  down = true;
  svc.awardXp(g.account, 700); // sync + enqueued; the DB is down
  check("resilience:gameplay_mutation_never_throws_when_db_down", g.account.xp === 700);
  const unavailable = await svc.loginPassword({ username: "someone", password: "whatever12" });
  check("resilience:login_reports_unavailable", unavailable.reason === "unavailable");
  const eph = await svc.loginGuest({ displayName: "Offline" });
  check("resilience:guest_degrades_to_ephemeral", eph.ok && eph.ephemeral === true);
  svc.awardXp(eph.account, 50);
  down = false; // DB recovers → the failed write is retried and lands
  await svc.flush(g.account.id);
  check("resilience:write_retried_after_recovery", (await mem.getById(g.account.id)).xp === 700);
  check("resilience:ephemeral_never_persisted", (await mem.getById(eph.account.id)) === null);
  await svc.close();
}

(async () => {
  const sd = fs.mkdtempSync(path.join(os.tmpdir(), "iron-svc-sql-"));
  const jd = fs.mkdtempSync(path.join(os.tmpdir(), "iron-svc-json-"));
  await run("sqlite", () => openStore({ kind: "sqlite", dir: sd }));
  await run("json", () => openStore({ kind: "json", dir: jd }));
  const mem = newDb({ noAstCoverageCheck: true });
  const pool = new (mem.adapters.createPg().Pool)();
  await run("postgres(pg-mem)", () => PostgresStore.open({ pool }));
  if (process.env.IRON_TEST_DATABASE_URL) await run("postgres(real)", () => PostgresStore.open({ url: process.env.IRON_TEST_DATABASE_URL }));
  await resilience();
  for (const d of [sd, jd]) fs.rmSync(d, { recursive: true, force: true });

  console.log(JSON.stringify(R, null, 2));
  if (failed) { console.log(`\n${failed} FAILURE(S)`); process.exit(1); }
  console.log("\nALL ACCOUNT TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST CRASHED:", e); process.exit(1); });
