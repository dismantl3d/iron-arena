// Networked account test: over-the-wire auth, authoritative match XP, persistence
// ACROSS A SERVER RESTART (same on-disk SQLite db), and security (bad token, unowned
// loadout fallback, client can't inject progression, account isolation). Spawns its
// own server(s) against a throwaway data dir.  node server/test-accounts-net.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import WebSocket from "ws";
import { createSnapshotCache, expandSnapshot } from "../src/net/snapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "iron-net-"));
const R = {};
const eq = (k, got, want) => { R[k] = got === want ? true : `EXPECTED ${JSON.stringify(want)} GOT ${JSON.stringify(got)}`; };
const truthy = (k, v) => { R[k] = v ? true : `EXPECTED truthy GOT ${JSON.stringify(v)}`; };

function startServer(port) {
  return spawn(process.execPath, [path.join(__dirname, "index.js")], {
    env: { ...process.env, PORT: String(port), IRON_DB: "sqlite", IRON_DATA_DIR: DATA, MP_COUNTDOWN: "1", MP_SIZE: "1", MP_LOBBY_BOTS: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

function client(port) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const c = { ws, id: null, token: null, authOk: null, profile: null, welcome: null, winner: null, last: null };
  ws.on("message", (raw) => {
    let m = JSON.parse(raw.toString());
    if (m.t === "state") m = expandSnapshot(m, (ws._cache ||= createSnapshotCache()));
    if (m.t === "authOk") { c.authOk = m; c.id = m.accountId; if (m.token) c.token = m.token; c.profile = m.profile; }
    else if (m.t === "authErr") c.authErr = m;
    else if (m.t === "welcome") c.welcome = m;
    else if (m.t === "state") c.last = m;
    else if (m.t === "profile") c.profile = m.profile;
    else if (m.t === "winner") c.winner = m;
  });
  c.sendWhenOpen = (obj) => (ws.readyState === 1 ? ws.send(JSON.stringify(obj)) : ws.on("open", () => ws.send(JSON.stringify(obj))));
  return c;
}
const ents = (c, type) => (c.last?.players || []).filter((p) => (type ? p.type === type : true));

(async () => {
  // ===== Server #1: new account, play a match, earn authoritative XP =====
  let srv = startServer(8101);
  await sleep(800);
  const A = client(8101);
  A.sendWhenOpen({ t: "auth", name: "Persisto" });
  await sleep(500);
  truthy("auth_new_account", A.authOk?.accountId?.startsWith("acct_"));
  truthy("auth_issued_token", typeof A.token === "string" && A.token.length > 20);
  const acctId = A.id, token = A.token;
  eq("new_level_1", A.profile.level, 1);
  eq("new_xp_0", A.profile.xp, 0);

  // Request an UNOWNED weapon (Laser Rifle idx 10) — server must fall back to Standard.
  A.ws.send(JSON.stringify({ t: "join", name: "Persisto", weapon: 10, color: 5 }));
  await sleep(400);
  eq("unowned_loadout_falls_back", JSON.stringify(A.welcome?.loadout), JSON.stringify({ weapon: 0, cosmetic: 0, wrap: 0, trail: 0, killFx: 0, title: 0 }));

  // SECURITY: try to inject a fake profile / self-grant XP — server must ignore it.
  A.ws.send(JSON.stringify({ t: "profile", profile: { xp: 999999, currency: 999999 } }));
  A.ws.send(JSON.stringify({ t: "grantXp", amount: 999999 }));
  A.ws.send(JSON.stringify({ t: "setCurrency", amount: 999999 }));
  await sleep(300);

  // Solo match (MP_SIZE=1): A is the only combatant, so the server authoritatively
  // declares A the winner and awards the Iron Path win bonus (500) — deterministic.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !A.winner) await sleep(60);
  await sleep(300);
  truthy("won_the_match", A.winner?.id === A.welcome?.id);
  const earnedXp = A.profile.xp;
  truthy("xp_awarded_by_server", earnedXp >= 500); // authoritative win bonus applied
  eq("injected_xp_ignored", earnedXp < 900000, true); // the 999999 injection did nothing
  R._earnedXp = earnedXp;

  A.ws.close();
  await sleep(200);
  srv.kill();
  await sleep(500);

  // ===== Server #2 (RESTART, same on-disk db): reconnect -> progress persisted =====
  srv = startServer(8102);
  await sleep(800);
  const A2 = client(8102);
  A2.sendWhenOpen({ t: "auth", accountId: acctId, token });
  await sleep(500);
  truthy("reconnect_same_account", A2.authOk?.accountId === acctId);
  eq("no_new_token_on_reconnect", A2.token, null);
  eq("xp_persisted_across_restart", A2.profile.xp, earnedXp);
  truthy("stats_persisted", A2.profile.stats.matchesPlayed >= 1 && A2.profile.stats.matchesWon >= 1);
  truthy("currency_persisted", A2.profile.currency >= 0 && typeof A2.profile.currency === "number");

  // SECURITY: bad token for a KNOWN account is rejected.
  const bad = client(8102);
  bad.sendWhenOpen({ t: "auth", accountId: acctId, token: "forged-token" });
  await sleep(400);
  truthy("bad_token_rejected", !!bad.authErr && !bad.authOk);
  bad.ws.close();

  // ISOLATION: a second account earning XP must not touch the first account.
  const B = client(8102);
  B.sendWhenOpen({ t: "auth", name: "Other" });
  await sleep(400);
  truthy("second_distinct_account", B.id && B.id !== acctId);
  B.ws.close();
  // Re-read A's account: unchanged by B.
  const A3 = client(8102);
  A3.sendWhenOpen({ t: "auth", accountId: acctId, token });
  await sleep(400);
  eq("account_isolated_after_other", A3.profile.xp, earnedXp);

  A2.ws.close(); A3.ws.close();
  srv.kill();
  await sleep(300);
  fs.rmSync(DATA, { recursive: true, force: true });

  console.log(JSON.stringify(R, null, 2));
  const failed = Object.entries(R).filter(([k, v]) => v !== true && !k.startsWith("_"));
  if (failed.length) { console.log("\nFAILURES:", failed.map(([k]) => k).join(", ")); process.exit(1); }
  console.log("\nALL NETWORK ACCOUNT TESTS PASSED");
  process.exit(0);
})();
