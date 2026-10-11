// Over-the-wire test of the hosted-account auth protocol (spawns its own server on a
// throwaway SQLite db): guest → register (upgrade) → "new device" password login → session
// resume → forged/wrong credentials → rate limiting → one match seat per account (kick) →
// persistence across a graceful server restart → dev-unlock gating → origin allow-list →
// /healthz → client-supplied XP ignored.   node server/test-auth-net.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "iron-auth-"));
const R = {};
let failed = 0;
const check = (k, ok, detail = "") => { R[k] = ok ? true : `FAIL ${detail}`; if (!ok) failed++; };

const servers = [];
function startServer(port, env = {}) {
  const p = spawn(process.execPath, [path.join(__dirname, "index.js")], {
    env: { ...process.env, PORT: String(port), IRON_DB: "sqlite", IRON_DATA_DIR: DATA, MP_COUNTDOWN: "1", MP_SIZE: "1", MP_LOBBY_BOTS: "0", ...env },
    stdio: ["ignore", "ignore", "inherit"],
  });
  servers.push(p);
  return p;
}
const stop = (p, sig = "SIGTERM") => new Promise((res) => { p.once("exit", res); p.kill(sig); });

// A message-recording client with promise-based waiting.
function client(port, headers) {
  const ws = new WebSocket(`ws://localhost:${port}`, { headers });
  const c = { ws, log: [], waiters: [], closed: false };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    c.log.push(m);
    c.waiters = c.waiters.filter((w) => { if (w.pred(m)) { w.res(m); return false; } return true; });
  });
  ws.on("close", () => { c.closed = true; });
  ws.on("error", () => {});
  c.open = new Promise((res) => ws.on("open", res));
  c.send = async (o) => { await c.open; ws.send(JSON.stringify(o)); };
  c.wait = (type, ms = 4000) => new Promise((res, rej) => {
    const hit = c.log.find((m) => m.t === type); if (hit) return res(hit);
    c.waiters.push({ pred: (m) => m.t === type, res });
    setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), ms);
  });
  // send a request and take the NEXT authOk/authErr/profile reply
  c.ask = async (o, ...types) => {
    c.log.length = 0;
    await c.send(o);
    return new Promise((res, rej) => {
      c.waiters.push({ pred: (m) => types.includes(m.t), res });
      setTimeout(() => rej(new Error(`timeout on ${o.t}`)), 4000);
    });
  };
  return c;
}

(async () => {
  let srv = startServer(8121, { IRON_DEV_UNLOCK: "0", AUTH_RATE_PER_MIN: "40" });
  await sleep(900);

  // /healthz
  const hz = await (await fetch("http://localhost:8121/healthz")).json();
  check("healthz_ok", hz.ok === true && hz.db === "ok" && hz.backend === "sqlite", JSON.stringify(hz));

  // ---- guest → register (upgrade keeps the account) ----
  const A = client(8121);
  const g = await A.ask({ t: "auth", name: "Pilot", xp: 99999 }, "authOk", "authErr"); // xp must be ignored
  check("guest_created", g.t === "authOk" && g.kind === "guest" && !!g.token);
  check("client_supplied_xp_ignored", g.profile.xp === 0 && g.profile.level === 1);
  const guestId = g.accountId;
  const bad = await A.ask({ t: "register", username: "x", password: "longenough1" }, "authOk", "authErr");
  check("register_rejects_bad_username", bad.t === "authErr" && bad.reason === "username-invalid");
  const r = await A.ask({ t: "register", username: "Ace_Pilot", password: "correct horse 9" }, "authOk", "authErr");
  check("register_upgrades_guest", r.t === "authOk" && r.accountId === guestId && r.kind === "registered" && !!r.sessionToken && r.upgraded);
  const session = r.sessionToken;

  // earn authoritative XP: solo match (MP_SIZE=1) → winner bonus 500
  await A.send({ t: "join", name: "Pilot", weapon: 0 });
  const prof = await A.wait("profile", 9000).catch(() => null);
  check("server_awarded_match_xp", !!prof && prof.profile.xp >= 500, JSON.stringify(prof?.profile?.xp));
  const earned = prof?.profile?.xp ?? 0;

  // ---- new device: password login from a fresh socket ----
  const B = client(8121);
  const wrong = await B.ask({ t: "login", username: "ace_pilot", password: "nope nope nope" }, "authOk", "authErr");
  const unknown = await B.ask({ t: "login", username: "ghost_user", password: "nope nope nope" }, "authOk", "authErr");
  check("wrong_pw_and_unknown_user_identical", wrong.reason === "bad-credentials" && unknown.reason === "bad-credentials");
  const li = await B.ask({ t: "login", username: "ACE_PILOT", password: "correct horse 9" }, "authOk", "authErr");
  check("new_device_login_same_account", li.t === "authOk" && li.accountId === guestId && li.profile.xp === earned, JSON.stringify(li.profile?.xp));
  check("login_issues_session_not_secret", !!li.sessionToken && !li.token);

  // ---- session resume / forged ----
  const C = client(8121);
  const rs = await C.ask({ t: "resume", sessionToken: li.sessionToken }, "authOk", "authErr");
  check("resume_ok", rs.t === "authOk" && rs.accountId === guestId);
  const forged = await C.ask({ t: "resume", sessionToken: "f".repeat(43) }, "authOk", "authErr");
  check("forged_session_rejected", forged.t === "authErr" && forged.reason === "bad-session");
  const gOld = await C.ask({ t: "auth", accountId: guestId, token: g.token }, "authOk", "authErr");
  check("old_guest_token_no_longer_works", gOld.t === "authErr" && gOld.reason === "use-login");

  // ---- one match seat per account: a second join kicks the first ----
  const D = client(8121), E = client(8121);
  await D.ask({ t: "resume", sessionToken: li.sessionToken }, "authOk");
  await D.send({ t: "join", name: "Pilot" });
  await D.wait("welcome");
  await E.ask({ t: "resume", sessionToken: li.sessionToken }, "authOk");
  await E.send({ t: "join", name: "Pilot" });
  await E.wait("welcome");
  const kicked = await D.wait("kicked", 3000).catch(() => null);
  check("second_join_kicks_first_seat", !!kicked);
  for (const c of [A, B, C, D, E]) c.ws.close();

  // ---- rate limiting (budget 40/min per IP; password ops cost 3) ----
  const F = client(8121);
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++) { const x = await F.ask({ t: "login", username: "ghost_user", password: "nope nope nope" }, "authErr", "authOk"); limited = x.reason === "rate-limited"; }
  check("auth_rate_limited", limited);
  F.ws.close();

  // ---- graceful shutdown flushes; progress survives a server restart (new "machine") ----
  await stop(srv, "SIGTERM");
  srv = startServer(8122, { IRON_DEV_UNLOCK: "0" });
  await sleep(900);
  const G = client(8122);
  const after = await G.ask({ t: "login", username: "ace_pilot", password: "correct horse 9" }, "authOk", "authErr");
  check("progress_survives_restart", after.t === "authOk" && after.profile.xp === earned && after.profile.stats.matchesWon >= 1, JSON.stringify(after.profile?.stats));
  check("session_survives_restart", (await G.ask({ t: "resume", sessionToken: li.sessionToken }, "authOk", "authErr")).t === "authOk");

  // ---- dev-unlock gating (server env; a client can't unlock itself) ----
  const dev0 = await G.ask({ t: "devUnlock" }, "profile");
  check("dev_unlock_refused_when_disabled", dev0.devUnlock === false && dev0.profile.level < 60);
  G.ws.close();
  await stop(srv);
  srv = startServer(8123, { IRON_DEV_UNLOCK: "1" });
  await sleep(900);
  const H = client(8123);
  await H.ask({ t: "login", username: "ace_pilot", password: "correct horse 9" }, "authOk");
  const dev1 = await H.ask({ t: "devUnlock" }, "profile");
  check("dev_unlock_works_when_enabled", dev1.devUnlock === true && dev1.profile.level === 60 && dev1.profile.unlocks.weapons.length === 11);
  const cos = await H.ask({ t: "setLoadout", weapon: 8, color: 3, wrap: 2, trail: 3, killFx: 1, title: 4 }, "profile");
  check("loadout_persisted_validated_after_unlock", JSON.stringify(cos.profile.loadout) === JSON.stringify({ weapon: 8, cosmetic: 3, wrap: 2, trail: 3, killFx: 1, title: 4 }), JSON.stringify(cos.profile.loadout));
  H.ws.close();
  await stop(srv);

  // ---- origin allow-list ----
  srv = startServer(8124, { ALLOWED_ORIGINS: "https://play.example.com" });
  await sleep(900);
  const noOrigin = client(8124);
  await sleep(500);
  check("origin_missing_rejected", noOrigin.closed === true || noOrigin.ws.readyState !== 1);
  const badOrigin = client(8124, { Origin: "https://evil.example.com" });
  await sleep(500);
  check("origin_wrong_rejected", badOrigin.closed === true || badOrigin.ws.readyState !== 1);
  const good = client(8124, { Origin: "https://play.example.com" });
  const ok = await good.ask({ t: "auth", name: "Good" }, "authOk", "authErr");
  check("origin_allowed_connects", ok.t === "authOk");
  good.ws.close();
  await stop(srv);

  // ---- hosted DB unreachable: server stays up, says "unavailable" (never "wrong password"), guests degrade ----
  srv = startServer(8125, { IRON_DB: "postgres", DATABASE_URL: "postgres://nobody:nopass@127.0.0.1:1/none", PGSSLMODE: "disable" });
  await sleep(2500);
  const hz2 = await (await fetch("http://localhost:8125/healthz")).json();
  check("dead_db_server_stays_up_and_reports_down", hz2.ok === true && hz2.db === "down" && hz2.backend === "postgres", JSON.stringify(hz2));
  const Z = client(8125);
  const un = await Z.ask({ t: "login", username: "someone", password: "whatever123" }, "authOk", "authErr");
  check("dead_db_login_says_unavailable_not_bad_credentials", un.t === "authErr" && un.reason === "unavailable", JSON.stringify(un));
  const eg = await Z.ask({ t: "auth", name: "Survivor" }, "authOk", "authErr");
  check("dead_db_guest_degrades_to_ephemeral", eg.t === "authOk" && eg.ephemeral === true);
  Z.ws.close();
  await stop(srv);

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(JSON.stringify(R, null, 2));
  if (failed) { console.log(`\n${failed} FAILURE(S)`); process.exit(1); }
  console.log("\nALL AUTH NETWORK TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("TEST CRASHED:", e); servers.forEach((s) => s.kill()); process.exit(1); });
