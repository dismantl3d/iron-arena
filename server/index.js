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

const PORT = Number(process.env.PORT) || 8080;
const TICK = 30; // authoritative simulation ticks per second
const DT = 1 / TICK;
const RESPAWN_DELAY = 3; // seconds a dead player waits before it may respawn
const MATCH_SIZE = Number(process.env.MP_SIZE ?? GAME.match.matchSize); // total roster (humans + bots)
const WAITING_BOTS = Number(process.env.MP_LOBBY_BOTS ?? 6); // bots idling in the lobby
const COUNTDOWN = Number(process.env.MP_COUNTDOWN ?? GAME.match.countdown); // lobby countdown (s)
const WINNER_HOLD = 6; // seconds a finished round holds before returning to the lobby

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
  phase = "playing";
  winnerAnnounced = false;
  winnerHold = 0;
  broadcast({ t: "matchStart", arena: world.arena, walls: world.wallData() });
  console.log(`[iron-arena] match started — ${aliveHumans()} human(s) + ${aliveBots()} bot(s)`);
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

    if (msg.t === "join") {
      if (ws.playerId) return; // already joined
      const id = `player_${String(++seqPlayer).padStart(3, "0")}`;
      const name = (typeof msg.name === "string" && msg.name.trim().slice(0, 20)) || id;
      const e = world.addEntity({ id, type: "player", team: id, name, color: numColor(msg.color) });
      // Store the player's authoritative cosmetics (indices into the shared GAME
      // arrays) so the model carries them for kill attribution / rendering. The
      // simulation ignores them; they're passthrough identity.
      e.wrap = idx(msg.wrap); e.trail = idx(msg.trail); e.killFx = idx(msg.killFx);
      e.title = idx(msg.title); e.weapon = idx(msg.weapon);
      world.resolveStats(id); // apply the player's chosen weapon's authoritative stats
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
  ws.playerId = null;
  if (world.removeEntity(id)) {
    sockets.delete(id);
    deadAt.delete(id);
    broadcast({ t: "leave", id });
    console.log(`[iron-arena] ${id} left — ${world.entities.size} player(s)`);
  }
}

function numColor(c) {
  return typeof c === "number" && Number.isFinite(c) ? c : 0;
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
      broadcast({ t: "winner", id: w.id, name: w.name, isBot: w.type === "bot" });
      console.log(`[iron-arena] winner: ${w.id} (${w.name})`);
    }
  }
  if (winnerAnnounced) {
    winnerHold -= DT;
    if (winnerHold <= 0) resetLobby(); // return everyone to a fresh lobby
  }
}, 1000 / TICK);
