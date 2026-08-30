// Iron Arena — authoritative multiplayer server (Phase 1 foundation).
//
// The server owns the truth. Clients send INTENT only (move axis, aim angle, fire)
// — never positions, damage, or hit claims. The authoritative simulation now lives
// in the SHARED, renderer-free world model (src/sim/WorldModel.js) so the exact same
// logic can later run on the client too; this file is just the networking shell:
// sockets, ids, message routing, a fixed-tick step + snapshot broadcast.
//
// Run:  npm run server   (listens on ws://<host>:8080)

import { WebSocketServer } from "ws";
import { WorldModel } from "../src/sim/WorldModel.js";
import { SIM } from "../src/sim/constants.js";
import { GAME } from "../src/config.js";
import { BotBrain } from "../src/game/BotBrain.js"; // pure decision layer (no Pixi/DOM)
import { makeNameGen } from "../src/game/ai/names.js";
import { earnedXp } from "../src/game/IronPath.js"; // existing match-XP formula (shared)
import { AccountService } from "./accounts/service.js"; // persistent, server-authoritative accounts

const PORT = Number(process.env.PORT) || 8080;
const TICK = 30; // authoritative simulation ticks per second
const DT = 1 / TICK;
const RESPAWN_DELAY = 3; // seconds a dead player waits before it may respawn
const MATCH_SIZE = Number(process.env.MP_SIZE ?? GAME.match.matchSize); // total roster (humans + bots)
const WAITING_BOTS = Number(process.env.MP_LOBBY_BOTS ?? 6); // bots idling in the lobby
const COUNTDOWN = Number(process.env.MP_COUNTDOWN ?? GAME.match.countdown); // lobby countdown (s)
const WINNER_HOLD = 6; // seconds a finished round holds before returning to the lobby

// Persistent account store (server-authoritative progression). Opens SQLite by
// default and degrades gracefully (JSON -> memory) so the server never crashes over
// storage. Top-level await: ready before any connection is served.
const accounts = await AccountService.open();
console.log(`[iron-arena] account store: ${accounts.backend} (${accounts.store.count?.() ?? 0} account(s))`);

// --- authoritative world + connection bookkeeping --------------------------------
const world = new WorldModel({
  fog: true, // authoritative zone; the bot AI's perception also reads fog.radius
  onKill: ({ victim, killer }) => {
    deadAt.set(victim, Date.now() / 1000);
    // Enrich with the killer's authoritative appearance so clients can render the
    // "Killed By" card (killer tank + name + title) without trusting the client.
    const k = killer ? world.get(killer) : null;
    // Guardians are text-only on the death screen (like single-player); humans/bots
    // carry their full authoritative appearance for the "Killed By" card.
    const killerInfo = !k
      ? null
      : k.type === "guardian"
        ? { name: "a Guardian", isGuardian: true }
        : { name: k.name, color: k.color ?? 0, wrap: k.wrap ?? 0, weapon: k.weapon ?? 0, title: k.title ?? 0, isBot: k.type === "bot" };
    // Credit a human killer's per-match tally (for authoritative XP on match end).
    if (k && k.type === "player") k._matchKills = (k._matchKills || 0) + 1;
    // A human victim earns their match XP (kills + survival) authoritatively now.
    const ve = world.get(victim);
    if (ve && ve.type === "player") awardMatchXp(victim, false);
    broadcast({ t: "kill", victim, killer: killer ?? null, killerInfo });
    console.log(`[iron-arena] ${killer ?? "?"} eliminated ${victim}`);
  },
});
const sockets = new Map(); // id -> ws (which connection owns which entity)
const deadAt = new Map(); // id -> death time (for respawn gating)
let seqPlayer = 0;
let seqBot = 0;
const nameGen = makeNameGen();

// --- match phase (authoritative lobby → battle royale → winner) -----------------
let phase = "waiting"; // "waiting" (lobby countdown) | "playing" (live BR)
let countdown = COUNTDOWN; // seconds left in the lobby before the match starts
let winnerAnnounced = false;
let winnerHold = 0; // seconds a finished round lingers before resetting the lobby

// --- server-side bots ------------------------------------------------------------
// Bots are WorldModel entities driven by the SAME BotBrain the single-player game
// uses (fresh random genome — no localStorage on the server). They run ONLY here;
// clients just receive their authoritative state. This is the Step-4 flow moved
// into the server tick: BotBrain.think() -> setInput() -> world.step().
function spawnBot() {
  const id = "bot_" + String(++seqBot).padStart(3, "0");
  const e = world.addEntity({ id, type: "bot", team: id, name: nameGen(), color: 0 });
  e.ai = new BotBrain(world.aiView(), null); // reads the world, returns intent
  e.skill = e.ai.skill;
  world.resolveStats(id); // Standard baseline (upgrades apply here later)
  return e;
}
function aliveBots() {
  let n = 0;
  for (const e of world._list) if (e.type === "bot" && e.alive) n++;
  return n;
}
function aliveHumans() {
  let n = 0;
  for (const e of world._list) if (e.type === "player" && e.alive) n++;
  return n;
}
// Lobby ambiance: keep a small handful of bots idling in the waiting room.
function refillLobbyBots() {
  for (const e of world._list) {
    if (aliveBots() >= WAITING_BOTS) break;
    if (e.type === "bot" && !e.alive) world.respawn(e.id);
  }
  while (aliveBots() < WAITING_BOTS) spawnBot();
}
// Fill the BR roster so humans + bots == MATCH_SIZE (reuse dead bots, then spawn).
function fillMatchRoster() {
  const humans = [...world._list].filter((e) => e.type === "player").length;
  const target = Math.max(0, MATCH_SIZE - humans);
  for (const e of world._list) {
    if (aliveBots() >= target) break;
    if (e.type === "bot" && !e.alive) world.respawn(e.id);
  }
  while (aliveBots() < target) spawnBot();
  // Trim any surplus bots (e.g. many humans joined) down to the target.
  const surplus = aliveBots() - target;
  if (surplus > 0) {
    let removed = 0;
    for (const e of [...world._list]) {
      if (removed >= surplus) break;
      if (e.type === "bot") { world.removeEntity(e.id); removed++; }
    }
  }
}
// Trim the bot population down to `n` (used when returning to the lobby).
function trimBotsTo(n) {
  let over = aliveBots() - n;
  for (const e of [...world._list]) {
    if (over <= 0) break;
    if (e.type === "bot") { world.removeEntity(e.id); over--; }
  }
}

// --- match lifecycle -------------------------------------------------------------
function startMatch() {
  fillMatchRoster();
  world.beginMatch(); // real arena, guardians, walls, loot, fog reset
  // Reset each human's per-match counters (kills + survival clock + award guard).
  // These are MATCH state, never persisted — only the resulting XP is saved.
  for (const e of world._list) if (e.type === "player") { e._matchStart = Date.now(); e._matchKills = 0; e._matchAwarded = false; }
  phase = "playing";
  winnerAnnounced = false;
  winnerHold = 0;
  broadcast({ t: "matchStart", arena: world.arena, walls: world.wallData() });
  console.log(`[iron-arena] match started — ${aliveHumans()} human(s) + ${aliveBots()} bot(s)`);
}

// Authoritatively award a human's MATCH progression to their account: XP (via the
// existing earnedXp formula) + persistent stats, then push the updated profile to
// the client. Guarded so each human is awarded at most once per match. This is the
// ONLY place match results become persistent account data (match state stays in the
// world model and is discarded).
function awardMatchXp(entityId, won) {
  const ws = sockets.get(entityId);
  const e = world.get(entityId);
  const acct = ws?.account;
  if (!acct || !e || e._matchAwarded) return;
  e._matchAwarded = true;
  const survival = e._matchStart ? (Date.now() - e._matchStart) / 1000 : 0;
  const kills = e._matchKills || 0;
  const xp = earnedXp({ kills, survival, won });
  const summary = accounts.awardXp(acct, xp); // adds XP, grants rewards/currency, saves
  accounts.recordMatch(acct, { kills, survival, won }); // persistent stats, saves
  send(ws, { t: "profile", profile: accounts.profile(acct), reward: { xp, ...summary, won } });
  console.log(`[iron-arena] ${entityId} (${acct.id}) +${xp}xp${won ? " (WON)" : ""} -> L${summary.level}`);
}

function resetLobby() {
  world.resetToWaiting(); // small arena, clear loot/guardians/walls, heal + respawn everyone
  trimBotsTo(WAITING_BOTS);
  phase = "waiting";
  countdown = COUNTDOWN;
  winnerAnnounced = false;
  winnerHold = 0;
  for (const id of deadAt.keys()) deadAt.delete(id);
  broadcast({ t: "lobby", countdown: COUNTDOWN });
  console.log(`[iron-arena] returned to lobby`);
}

// --- networking ------------------------------------------------------------------
const wss = new WebSocketServer({ port: PORT });
console.log(`[iron-arena] multiplayer server listening on ws://localhost:${PORT}`);

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.playerId = null;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed input
    }
    if (!msg || typeof msg.t !== "string") return;

    // Authenticate / identify the account. Returning clients present {accountId,
    // token}; a fresh client presents neither (or an unknown id) and is minted a new
    // guest account. The server sends back the AUTHORITATIVE profile; the raw token
    // is issued exactly once (on creation). The client never provides its own XP/
    // unlocks — those are decided here.
    if (msg.t === "auth") {
      const res = accounts.login({ accountId: msg.accountId, token: msg.token, displayName: msg.name });
      if (!res.ok) { send(ws, { t: "authErr", reason: res.reason }); return; }
      ws.account = res.account;
      ws.accountId = res.account.id;
      send(ws, { t: "authOk", accountId: res.account.id, ...(res.token ? { token: res.token } : {}), profile: accounts.profile(res.account) });
      return;
    }

    if (msg.t === "join") {
      if (ws.playerId) return; // already joined
      // A client that didn't authenticate first gets an auto guest account (keeps
      // headless/dev clients working); real clients auth beforehand.
      if (!ws.account) { const g = accounts.login({ displayName: msg.name }); ws.account = g.account; ws.accountId = g.account.id; }
      const account = ws.account;
      const id = `player_${String(++seqPlayer).padStart(3, "0")}`;
      const name = account.displayName || "Unnamed Tank"; // account identity is the id, not the name
      const e = world.addEntity({ id, type: "player", team: id, name, color: 0 });
      // AUTHORITATIVE loadout: validate the requested indices against what the account
      // actually owns (unowned weapon/cosmetic falls back to the default) and equip
      // the result. The entity carries the VALIDATED indices (used for rendering +
      // kill attribution), so a client can never spawn with an unowned item.
      const applied = accounts.setLoadout(account, { weapon: idx(msg.weapon), cosmetic: idx(msg.color), wrap: idx(msg.wrap), trail: idx(msg.trail), killFx: idx(msg.killFx), title: idx(msg.title) });
      e.color = applied.cosmetic; e.wrap = applied.wrap; e.trail = applied.trail;
      e.killFx = applied.killFx; e.title = applied.title; e.weapon = applied.weapon;
      e.accountId = account.id; // link entity -> account (for authoritative match XP)
      world.resolveStats(id); // apply the (validated) weapon's authoritative stats
      sockets.set(id, ws);
      ws.playerId = id;
      if (phase === "playing") placeJoinerInArena(e); // late joiner drops into the live BR
      else refillLobbyBots(); // lobby: show a few idling bots
      send(ws, {
        t: "welcome",
        id,
        tick: TICK,
        arena: world.arena,
        phase,
        countdown: Math.max(0, Math.ceil(countdown)),
        walls: phase === "playing" ? world.wallData() : [],
        loadout: applied, // the server-validated loadout the client actually spawned with
        config: { speed: SIM.speed, accel: SIM.accel, maxHp: SIM.maxHp, radius: SIM.radius, bulletRadius: SIM.bulletRadius, bulletSpeed: SIM.bulletSpeed, cooldown: SIM.cooldown },
      });
      console.log(`[iron-arena] ${id} (${name}) joined — ${world.entities.size} entit(y/ies), phase=${phase}`);
      return;
    }

    const id = ws.playerId;
    if (!id || !world.get(id)) return;

    if (msg.t === "input") {
      world.setInput(id, { mx: msg.mx, my: msg.my, aim: msg.aim, fire: msg.fire, detonate: msg.detonate });
    } else if (msg.t === "respawn") {
      // BR semantics: no mid-match respawn (deaths are permanent for the round). A
      // dead player rejoins when the round ends and the lobby resets. In the lobby,
      // "Play Again" just re-readies them.
      const e = world.get(id);
      if (phase === "waiting" && e && !e.alive) world.respawn(id);
    } else if (msg.t === "ping") {
      send(ws, { t: "pong", id: msg.id });
    }
  });

  ws.on("close", () => dropClient(ws));
  ws.on("error", () => dropClient(ws));
});

function dropClient(ws) {
  if (!ws.playerId) return;
  const id = ws.playerId;
  const e = world.get(id);
  // A player leaving mid-match keeps the XP/stats they earned (persisted before the
  // socket is torn down; the profile push simply won't reach the closed socket).
  if (e && e.type === "player" && e.alive && phase === "playing") awardMatchXp(id, false);
  ws.playerId = null;
  if (world.removeEntity(id)) {
    sockets.delete(id);
    deadAt.delete(id);
    broadcast({ t: "leave", id });
    console.log(`[iron-arena] ${id} left — ${world.entities.size} player(s)`);
  }
}

// A safe cosmetic array index (>= 0 integer, else 0).
function idx(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* client went away */ }
  }
}
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of sockets.values()) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(s); } catch { /* ignore */ }
    }
  }
}

// Drop clients that stopped answering pings (dead sockets).
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { dropClient(ws); ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 5000);

// Drop a late joiner (or the match roster) into the live arena's outer ring.
function placeJoinerInArena(e) {
  e.bounds = world.bounds;
  const a = Math.random() * Math.PI * 2, r = world.arena * 0.82;
  e.x = Math.cos(a) * r; e.y = Math.sin(a) * r; e.vx = 0; e.vy = 0;
  e._matchStart = Date.now(); e._matchKills = 0; e._matchAwarded = false; // fresh match clock
}

// Server-side bot DECISIONS → intent (the model, not the bot, owns outcomes).
// Guardians are driven inside the model, so we skip them here.
function driveBots() {
  for (const e of world._list) {
    if (e.type !== "bot" || !e.ai || !e.alive) continue;
    const cmd = e.ai.think(DT, e);
    const mv = cmd.move || { x: 0, y: 0 };
    world.setInput(e.id, { mx: mv.x, my: mv.y, aim: cmd.aim ?? e.rot, fire: e.ai.wantsFire });
  }
}

// --- authoritative tick ----------------------------------------------------------
setInterval(() => {
  if (!sockets.size) { // no human connected — hold the lobby idle
    if (phase !== "waiting") resetLobby();
    return;
  }

  if (phase === "waiting") {
    world.damageEnabled = false; // peaceful lobby: movement + preview firing, no harm
    refillLobbyBots();
    countdown -= DT;
    driveBots();
    world.step(DT);
    broadcast({ t: "state", now: Date.now(), countdown: Math.max(0, countdown), ...world.snapshot() });
    if (countdown <= 0) startMatch();
    return;
  }

  // phase === "playing": drive bots, step, broadcast, decide the winner.
  world.damageEnabled = true;
  driveBots();
  world.step(DT);
  broadcast({ t: "state", now: Date.now(), ...world.snapshot() });

  const alive = world.aliveCombatants();
  if (!winnerAnnounced && alive <= 1) {
    winnerAnnounced = true;
    winnerHold = WINNER_HOLD;
    const w = world._list.find((e) => e.alive && (e.type === "player" || e.type === "bot"));
    if (w) {
      if (w.type === "player") awardMatchXp(w.id, true); // authoritative win bonus
      broadcast({ t: "winner", id: w.id, name: w.name, isBot: w.type === "bot" });
      console.log(`[iron-arena] winner: ${w.id} (${w.name})`);
    }
  }
  if (winnerAnnounced) {
    winnerHold -= DT;
    if (winnerHold <= 0) resetLobby(); // return everyone to a fresh lobby
  }
}, 1000 / TICK);
