// Iron Arena — authoritative multiplayer server.
//
// The server owns the truth. Clients send INTENT only (move axis, aim, fire) — never
// positions, damage, or hit claims. This file is a thin networking shell: it authenticates
// sockets against the (hosted) account database, MATCHMAKES each into an isolated `Match`
// (its own WorldModel), routes their input, and ticks every match at a fixed rate. All
// gameplay lives in the shared, renderer-free src/sim/WorldModel.
//
// Run:  npm run server        (ws://<host>:8080, GET /healthz for host health checks)
// Env:  PORT, IRON_DB (postgres|sqlite|json|memory) + DATABASE_URL, ALLOWED_ORIGINS,
//       TRUST_PROXY, AUTH_RATE_PER_MIN, SESSION_TTL_DAYS, IRON_DEV_UNLOCK, MP_* (match tuning).

import http from "node:http";
import { WebSocketServer } from "ws";
import { SIM } from "../src/sim/constants.js";
import { GAME } from "../src/config.js";
import { AccountService } from "./accounts/service.js"; // persistent, server-authoritative accounts
import { Match } from "./Match.js";

const PORT = Number(process.env.PORT) || 8080;
const TICK = 30; // authoritative simulation ticks per second
const DT = 1 / TICK;
const CFG = {
  MATCH_SIZE: Number(process.env.MP_SIZE ?? GAME.match.matchSize), // total roster (humans + bots)
  COUNTDOWN: Number(process.env.MP_COUNTDOWN ?? GAME.match.countdown), // lobby countdown (s)
  WAITING_BOTS: Number(process.env.MP_LOBBY_BOTS ?? 6), // bots idling in a waiting lobby
  WINNER_HOLD: 6, // seconds the finished match lingers before cleanup
  TICK, DT,
};
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const AUTH_RATE = Number(process.env.AUTH_RATE_PER_MIN || 60); // auth-type messages per IP per minute

// Account store (hosted Postgres in production; SQLite locally). A hosted DB that is down at
// boot does NOT stop the server: logins report "unavailable" (guests degrade to non-persistent).
let accounts;
try {
  accounts = await AccountService.open();
} catch (e) {
  // Only configuration errors reach here (an unreachable hosted DB is handled lazily by the store).
  if (process.env.NODE_ENV === "production") { console.error(`[iron-arena] FATAL: account store misconfigured: ${e.message}`); process.exit(1); }
  console.error(`[iron-arena] account store failed to open (${e.message}); using in-memory (NOT persistent) — dev only`);
  accounts = await AccountService.open({ kind: "memory" });
}
console.log(`[iron-arena] account store: ${accounts.backend} (dev-unlock ${accounts.devUnlockAllowed ? "ON" : "off"})`);
accounts.store.count?.().then((n) => console.log(`[iron-arena] ${n} account(s)`)).catch(() => {});

// --- matchmaking -----------------------------------------------------------------
const matches = new Map(); // lobbyId -> Match
const matchSockets = new Map(); // accountId -> ws currently seated in a match (one seat per account)

// Find an available WAITING lobby with room, or create a new one. A player is NEVER placed
// into a PLAYING match (late joins go to a waiting/new lobby).
function matchmake() {
  for (const m of matches.values()) if (m.canJoin()) return m;
  const m = new Match(accounts, CFG);
  matches.set(m.id, m);
  console.log(`[iron-arena] created ${m.id} (${matches.size} lobby/lobbies)`);
  return m;
}

// --- http (health) + websocket ---------------------------------------------------
const httpServer = http.createServer(async (req, res) => {
  if (req.url === "/healthz" || req.url === "/") {
    let db = "ok";
    try { await accounts.health(); } catch { db = "down"; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, db, backend: accounts.backend, lobbies: matches.size }));
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({
  server: httpServer,
  // Optional origin allow-list (set ALLOWED_ORIGINS in production). Non-browser clients
  // (no Origin header) are only allowed when no list is configured.
  verifyClient: ({ origin }) => !ALLOWED_ORIGINS.length || (!!origin && ALLOWED_ORIGINS.includes(origin)),
});
httpServer.listen(PORT, () => console.log(`[iron-arena] multiplayer server listening on ws://localhost:${PORT}`));

// Per-IP fixed-window rate limit for auth-type messages (cost weights password work higher).
const rate = new Map(); // ip -> { n, reset }
function allow(ip, cost = 1) {
  const now = Date.now();
  let r = rate.get(ip);
  if (!r || r.reset < now) { r = { n: 0, reset: now + 60000 }; rate.set(ip, r); }
  r.n += cost;
  return r.n <= AUTH_RATE;
}
setInterval(() => { const now = Date.now(); for (const [ip, r] of rate) if (r.reset < now) rate.delete(ip); }, 60000).unref();

function clientIp(req) {
  if (TRUST_PROXY) { const f = req.headers["x-forwarded-for"]; if (f) return String(f).split(",")[0].trim(); }
  return req.socket.remoteAddress || "?";
}

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.playerId = null;
  ws.match = null;
  ws.account = null;
  ws.ip = clientIp(req);
  ws.chain = Promise.resolve(); // serialize auth-type messages per socket
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;

    // Hot path: gameplay messages stay synchronous.
    if (msg.t === "input") { if (ws.match && ws.playerId) ws.match.input(ws.playerId, msg); return; }
    if (msg.t === "ping") { send(ws, { t: "pong", id: msg.id }); return; }

    // Everything else (auth, account ops, join) may hit the database → serialize per socket.
    ws.chain = ws.chain.then(() => handle(ws, msg)).catch((e) => console.warn(`[iron-arena] handler error (${msg.t}): ${e.message}`));
  });

  ws.on("close", () => { dropClient(ws); });
  ws.on("error", () => { dropClient(ws); });
});

// Attach an authenticated account to a socket (releasing any previous one) and reply authOk.
async function setAccount(ws, res) {
  const prev = ws.account;
  ws.account = res.account;
  if (prev) await accounts.release(prev); // drop the old ref (or the duplicate ref if the same account re-authed)
  const a = res.account;
  send(ws, {
    t: "authOk",
    accountId: a.id,
    kind: a.kind,
    ...(res.token ? { token: res.token } : {}), // guest creds: issued once on creation
    ...(res.sessionToken ? { sessionToken: res.sessionToken } : {}), // registered: session
    ...(res.ephemeral ? { ephemeral: true } : {}),
    profile: accounts.profile(a),
  });
}

const authErr = (ws, reason, op) => send(ws, { t: "authErr", reason, op });

async function handle(ws, msg) {
  switch (msg.t) {
    // Guest identity (zero-friction): {accountId, token} or a fresh guest.
    case "auth": {
      if (!allow(ws.ip)) return authErr(ws, "rate-limited", "auth");
      const res = await accounts.loginGuest({ accountId: msg.accountId, token: msg.token, displayName: msg.name });
      return res.ok ? setAccount(ws, res) : authErr(ws, res.reason, "auth");
    }
    case "register": {
      if (!allow(ws.ip, 3)) return authErr(ws, "rate-limited", "register");
      const res = await accounts.register(ws.account, { username: msg.username, password: msg.password });
      if (!res.ok) return authErr(ws, res.reason, "register");
      if (res.account === ws.account) { send(ws, { t: "authOk", accountId: res.account.id, kind: "registered", sessionToken: res.sessionToken, profile: accounts.profile(res.account), upgraded: true }); return; }
      return setAccount(ws, res);
    }
    case "login": {
      if (!allow(ws.ip, 3)) return authErr(ws, "rate-limited", "login");
      const res = await accounts.loginPassword({ username: msg.username, password: msg.password });
      return res.ok ? setAccount(ws, res) : authErr(ws, res.reason, "login");
    }
    case "resume": {
      if (!allow(ws.ip)) return authErr(ws, "rate-limited", "resume");
      const res = await accounts.resume(msg.sessionToken);
      return res.ok ? setAccount(ws, res) : authErr(ws, res.reason, "resume");
    }
    case "logout": {
      await accounts.logout(msg.sessionToken);
      const prev = ws.account; ws.account = null;
      await accounts.release(prev);
      return send(ws, { t: "loggedOut" });
    }

    // Account ops on an authenticated socket (server decides; client only requests).
    case "devUnlock": {
      if (!ws.account) return;
      const ok = accounts.devUnlock(ws.account);
      return send(ws, { t: "profile", profile: accounts.profile(ws.account), devUnlock: ok });
    }
    case "setLoadout": { // persist menu loadout changes (validated against owned items)
      if (!ws.account) return;
      accounts.setLoadout(ws.account, { weapon: idx(msg.weapon), cosmetic: idx(msg.color), wrap: idx(msg.wrap), trail: idx(msg.trail), killFx: idx(msg.killFx), title: idx(msg.title) });
      if (typeof msg.name === "string") accounts.setDisplayName(ws.account, msg.name);
      return send(ws, { t: "profile", profile: accounts.profile(ws.account) });
    }

    // PLAY / matchmaking request: seat this socket in a waiting lobby (creating one if needed)
    // with its validated loadout. Each `join` is a fresh matchmaking request — a returning
    // player never reattaches to an old match.
    case "join": {
      if (ws.playerId) return; // already in a match
      if (!ws.account) { // headless/dev clients that skip auth get a guest automatically
        if (!allow(ws.ip)) return authErr(ws, "rate-limited", "join");
        const g = await accounts.loginGuest({ displayName: msg.name });
        if (!g.ok) return authErr(ws, g.reason, "join");
        ws.account = g.account;
      }
      // One match seat per account: a newer join replaces an older stale one.
      const old = matchSockets.get(ws.account.id);
      if (old && old !== ws) { send(old, { t: "kicked", reason: "joined-elsewhere" }); leaveMatch(old); try { old.close(); } catch { /* ignore */ } }
      if (typeof msg.name === "string") accounts.setDisplayName(ws.account, msg.name);
      const match = matchmake();
      const { id, applied } = match.addPlayer(ws, ws.account, msg);
      ws.match = match;
      ws.playerId = id;
      matchSockets.set(ws.account.id, ws);
      send(ws, {
        t: "welcome",
        id,
        lobby: match.id,
        tick: TICK,
        arena: match.world.arena,
        phase: match.state,
        countdown: Math.max(0, Math.ceil(match.countdown)),
        loadout: applied, // the server-validated loadout the client actually spawned with
        walls: match.state === "playing" ? match.wallData() : [],
        config: { speed: SIM.speed, accel: SIM.accel, maxHp: SIM.maxHp, radius: SIM.radius, bulletRadius: SIM.bulletRadius, bulletSpeed: SIM.bulletSpeed, cooldown: SIM.cooldown },
      });
      console.log(`[iron-arena] ${id} joined ${match.id} — ${match.humanCount} human(s), phase=${match.state}`);
      return;
    }
  }
}

// Remove a socket from its match (idempotent).
function leaveMatch(ws) {
  if (ws.account && matchSockets.get(ws.account.id) === ws) matchSockets.delete(ws.account.id);
  if (!ws.playerId) return;
  const id = ws.playerId;
  ws.playerId = null;
  ws.match?.removePlayer(id); // awards partial XP while ws.account is still attached
  ws.match = null;
}

async function dropClient(ws) {
  leaveMatch(ws);
  const a = ws.account;
  ws.account = null;
  if (a) await accounts.release(a); // flushes this player's pending saves when the last socket goes
}

const idx = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch { /* client went away */ } }
}

// Drop clients that stopped answering pings (dead sockets).
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { dropClient(ws); ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 5000);

// --- authoritative tick (all matches) --------------------------------------------
setInterval(() => {
  for (const m of [...matches.values()]) {
    if (!m.step(DT)) matches.delete(m.id); // step() returns false when the match ended
  }
}, 1000 / TICK);

// --- lifecycle -------------------------------------------------------------------
process.on("unhandledRejection", (e) => console.warn("[iron-arena] unhandled rejection:", e?.message || e));

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[iron-arena] ${sig} — shutting down, flushing accounts…`);
  for (const ws of wss.clients) { try { ws.close(1001, "server restarting"); } catch { /* ignore */ } }
  try { await Promise.race([accounts.close(), new Promise((r) => setTimeout(r, 8000))]); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
