// Account-layer tests: creation defaults, persistence across a store reopen (SQLite),
// Iron Path unlock + currency persistence (no duplicate grants), loadout validation,
// auth/security, and account isolation. Uses a throwaway temp dir.  node this file.

import { AccountService } from "./service.js";
import { idFor, indexFor } from "./ids.js";
import { levelForXp } from "../../src/game/IronPath.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const R = {};
const eq = (k, got, want) => { R[k] = JSON.stringify(got) === JSON.stringify(want) ? true : `EXPECTED ${JSON.stringify(want)} GOT ${JSON.stringify(got)}`; };
const truthy = (k, v) => { R[k] = v ? true : `EXPECTED truthy GOT ${JSON.stringify(v)}`; };

const KIND = process.env.IRON_DB || "sqlite";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iron-acct-"));

(async () => {
  let svc = await AccountService.open({ kind: KIND, dir });
  R.backend = svc.backend;

  // ---- Account creation: a NEW player gets sensible, safe defaults ----
  const r1 = svc.login({ displayName: "Tanky" });
  truthy("new_account_created", r1.ok && r1.isNew && r1.account.id.startsWith("acct_"));
  truthy("new_account_has_token", typeof r1.token === "string" && r1.token.length > 20);
  const acctId = r1.account.id, token = r1.token;
  const p1 = svc.profile(r1.account);
  eq("default_level_is_1", p1.level, 1);
  eq("default_currency_is_0", p1.currency, 0);
  eq("default_weapon_is_standard", p1.loadout.weapon, 0);
  eq("default_color_is_blue", p1.loadout.cosmetic, 0);
  eq("default_title_is_none_equipped", p1.loadout.title, 0); // No Title (unequipped) allowed
  eq("default_killfx_is_none_equipped", p1.loadout.killFx, 0); // No Kill FX allowed
  truthy("blue_unlocked_by_default", p1.unlocks.colors.includes(0));
  truthy("standard_unlocked_by_default", p1.unlocks.weapons.includes(0));

  // ---- Persistence: gain XP, save, reopen the store, verify it remains ----
  svc.awardXp(r1.account, 700); // -> level 2 (xpPerLevel 600)
  eq("xp_after_award", r1.account.xp, 700);
  eq("level_after_award", levelForXp(r1.account.xp), 2);
  svc.close();
  svc = await AccountService.open({ kind: KIND, dir }); // REOPEN (simulates restart / reconnect)
  const reload = svc.getById(acctId);
  truthy("account_persisted_across_reopen", !!reload);
  eq("xp_persisted", reload.xp, 700);
  eq("level_persisted", levelForXp(reload.xp), 2);

  // ---- Currency: level 2 grants $30 once; re-granting must NOT duplicate ----
  eq("currency_granted_on_levelup", reload.currency, 30); // ironPath L2 = money 30
  const before = reload.currency;
  svc.awardXp(reload, 0); // no new levels -> no new rewards
  eq("no_duplicate_currency_on_regrant", reload.currency, before);

  // ---- Unlocks: reach level 6 -> Dual Barrel weapon unlocked + persists ----
  svc.awardXp(reload, 3000 - reload.xp); // push to >=3000 total -> level 6
  eq("level_6_reached", levelForXp(reload.xp), 6);
  const dualId = idFor("weapons", 1);
  truthy("dual_barrel_unlocked", reload.unlocks.weapons.includes(dualId));
  svc.close();
  svc = await AccountService.open({ kind: KIND, dir });
  const reload2 = svc.getById(acctId);
  truthy("unlock_persisted_across_reopen", reload2.unlocks.weapons.includes(dualId));

  // ---- Loadout: equip an UNLOCKED weapon persists; UNOWNED falls back to default ----
  const applied = svc.setLoadout(reload2, { weapon: 1, cosmetic: 0, wrap: 0, trail: 0, killFx: 0, title: 0 });
  eq("equipped_unlocked_weapon", applied.weapon, 1);
  const badApplied = svc.setLoadout(reload2, { weapon: 4 }); // Sniper (unlocked at L24) — not owned
  eq("unowned_weapon_falls_back_to_default", badApplied.weapon, 0);
  // re-equip the valid one, reopen, verify it stuck
  svc.setLoadout(reload2, { weapon: 1 });
  svc.close();
  svc = await AccountService.open({ kind: KIND, dir });
  const reload3 = svc.getById(acctId);
  eq("loadout_persisted", indexFor("weapons", reload3.loadout.weapons), 1);

  // ---- Security: auth is token-gated ----
  eq("bad_token_rejected", svc.login({ accountId: acctId, token: "not-the-token" }).ok, false);
  const good = svc.login({ accountId: acctId, token });
  truthy("correct_token_accepted", good.ok && !good.isNew && good.account.id === acctId);
  eq("progress_intact_after_relogin", good.account.xp, reload3.xp);
  eq("no_token_returned_on_relogin", good.token, undefined); // token only issued at creation

  // ---- Isolation: two accounts don't affect each other ----
  const other = svc.login({ displayName: "Other" });
  svc.awardXp(other.account, 5000);
  const mine = svc.getById(acctId);
  eq("other_account_isolated", mine.xp, reload3.xp); // unchanged by the other account's XP
  truthy("two_distinct_accounts", other.account.id !== acctId);

  svc.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify(R, null, 2));
  const failed = Object.entries(R).filter(([k, v]) => v !== true && k !== "backend");
  if (failed.length) { console.log("\nFAILURES:", failed.map(([k]) => k).join(", ")); process.exit(1); }
  console.log("\nALL ACCOUNT TESTS PASSED");
})();
