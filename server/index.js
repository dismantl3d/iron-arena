// Iron Arena — authoritative multiplayer server.
//
// The server owns the truth. Clients send INTENT only (move axis, aim, fire) —
// never positions, damage, or hit claims. This file is a thin networking shell:
// it authenticates sockets (persistent accounts), MATCHMAKES each into an isolated
// `Match` (its own WorldModel), routes their input to that match, and ticks every
// match at a fixed rate. All gameplay lives in the shared, renderer-free
// src/sim/WorldModel; each Match owns one instance so matches never interfere.
//
// Multiple lobbies run concurrently: a joining player is placed into an available
// WAITING lobby (or a new one is created); a player NEVER joins a PLAYING match.
//
// Run:  npm run server   (listens on ws://<host>:8080)

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

// Persistent account store (server-authoritative progression). SQLite by default,
// degrading gracefully (JSON -> memory) so the server never crashes over storage.
const accounts = await AccountService.open();
console.log(`[iron-arena] account store: ${accounts.backend} (${accounts.store.count?.() ?? 0} account(s))`);

// --- matchmaking -----------------------------------------------------------------
const matches = new Map(); // lobbyId -> Match

// Find an available WAITING lobby with room, or create a new one. A player is NEVER
// placed into a PLAYING match (late joins go to a waiting/new lobby).
function matchmake() {
  for (const m of matches.values()) if (m.canJoin()) return m;
  const m = new Match(accounts, CFG);
  matches.set(m.id, m);
  console.log(`[iron-arena] created ${m.id} (${matches.size} lobby/lobbies)`);
  return m;
}

// --- networking ------------------------------------------------------------------
const wss = new WebSocketServer({ port: PORT });
console.log(`[iron-arena] multiplayer server listening on ws://localhost:${PORT}`);

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.playerId = null;
  ws.match = null;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;

    // Authenticate / identify the account (returning: {accountId, token}; fresh: new
    // guest + one-time token). The server sends the AUTHORITATIVE profile.
    if (msg.t === "auth") {
      const res = accounts.login({ accountId: msg.accountId, token: msg.token, displayName: msg.name });
      if (!res.ok) { send(ws, { t: "authErr", reason: res.reason }); return; }
      ws.account = res.account;
      send(ws, { t: "authOk", accountId: res.account.id, ...(res.token ? { token: res.token } : {}), profile: accounts.profile(res.account) });
      return;
    }

    // PLAY / matchmaking request: place this socket into a waiting lobby (creating one
    // if needed) and spawn its validated loadout. Each `join` is a fresh matchmaking
    // request — a returning player never reattaches to an old match.
    if (msg.t === "join") {
      if (ws.playerId) return; // already in a match
      if (!ws.account) { const g = accounts.login({ displayName: msg.name }); ws.account = g.account; }
      const match = matchmake();
      const { id, applied } = match.addPlayer(ws, ws.account, msg);
      ws.match = match;
      ws.playerId = id;
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

    const match = ws.match;
    if (!ws.playerId || !match) return;
    if (msg.t === "input") match.input(ws.playerId, msg);
    else if (msg.t === "ping") send(ws, { t: "pong", id: msg.id });
  });

  ws.on("close", () => dropClient(ws));
  ws.on("error", () => dropClient(ws));
});

function dropClient(ws) {
  if (!ws.playerId) return;
  const id = ws.playerId;
  ws.playerId = null;
  ws.match?.removePlayer(id);
  ws.match = null;
}

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
