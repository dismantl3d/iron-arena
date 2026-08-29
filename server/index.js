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
import { BotBrain } from "../src/game/BotBrain.js"; // pure decision layer (no Pixi/DOM)
import { makeNameGen } from "../src/game/ai/names.js";

const PORT = Number(process.env.PORT) || 8080;
const TICK = 30; // authoritative simulation ticks per second
const DT = 1 / TICK;
const RESPAWN_DELAY = 3; // seconds a dead player waits before it may respawn
const BOT_TARGET = Number(process.env.MP_BOTS ?? 8); // server-side bots filling the match

// --- authoritative world + connection bookkeeping --------------------------------
const world = new WorldModel({
  fog: true, // authoritative zone; the bot AI's perception also reads fog.radius
  onKill: ({ victim, killer }) => {
    deadAt.set(victim, Date.now() / 1000);
    // Enrich with the killer's authoritative appearance so clients can render the
    // "Killed By" card (killer tank + name + title) without trusting the client.
    const k = killer ? world.get(killer) : null;
    const killerInfo = k
      ? { name: k.name, color: k.color ?? 0, wrap: k.wrap ?? 0, weapon: k.weapon ?? 0, title: k.title ?? 0, isBot: k.type === "bot" }
      : null;
    broadcast({ t: "kill", victim, killer: killer ?? null, killerInfo });
    console.log(`[iron-arena] ${killer ?? "?"} eliminated ${victim}`);
  },
});
const sockets = new Map(); // id -> ws (which connection owns which entity)
const deadAt = new Map(); // id -> death time (for respawn gating)
let seqPlayer = 0;
let seqBot = 0;
const nameGen = makeNameGen();

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
// Keep the match populated: refill up to BOT_TARGET (reuse dead bots, then spawn).
function refillBots() {
  for (const e of world._list) {
    if (aliveBots() >= BOT_TARGET) return;
    if (e.type === "bot" && !e.alive) world.respawn(e.id);
  }
  while (aliveBots() < BOT_TARGET) spawnBot();
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
      refillBots(); // a joining human should find a full match of bots
      send(ws, {
        t: "welcome",
        id,
        tick: TICK,
        arena: world.arena,
        config: { speed: SIM.speed, accel: SIM.accel, maxHp: SIM.maxHp, radius: SIM.radius, bulletRadius: SIM.bulletRadius, bulletSpeed: SIM.bulletSpeed, cooldown: SIM.cooldown },
      });
      console.log(`[iron-arena] ${id} (${name}) joined — ${world.entities.size} player(s)`);
      return;
    }

    const id = ws.playerId;
    if (!id || !world.get(id)) return;

    if (msg.t === "input") {
      world.setInput(id, { mx: msg.mx, my: msg.my, aim: msg.aim, fire: msg.fire, detonate: msg.detonate });
    } else if (msg.t === "respawn") {
      const e = world.get(id);
      if (e && !e.alive && Date.now() / 1000 - (deadAt.get(id) ?? 0) >= RESPAWN_DELAY) {
        world.respawn(id);
      }
      refillBots(); // top up the match — also lets a winner start a fresh round
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

// --- authoritative tick ----------------------------------------------------------
spawnBotsInitial();
function spawnBotsInitial() { refillBots(); }
let winnerAnnounced = false;

setInterval(() => {
  if (!sockets.size) return; // no human connected — pause the sim (bots idle at spawn)

  // 1) Server-side bot DECISIONS -> intent (the model, not the bot, owns outcomes).
  for (const e of world._list) {
    if (!e.ai || !e.alive) continue;
    const cmd = e.ai.think(DT, e);
    const mv = cmd.move || { x: 0, y: 0 };
    world.setInput(e.id, { mx: mv.x, my: mv.y, aim: cmd.aim ?? e.rot, fire: e.ai.wantsFire });
  }

  // 2) Authoritative simulation + broadcast to all connected clients.
  world.step(DT);
  broadcast({ t: "state", now: Date.now(), ...world.snapshot() });

  // 3) Authoritative match end: the server (not any client) decides the winner.
  //    A round thins out (bots aren't refilled mid-round) until one entity remains.
  const alive = world._list.filter((e) => e.alive);
  if (alive.length > 1) winnerAnnounced = false; // a fresh, populated round
  else if (alive.length === 1 && !winnerAnnounced) {
    winnerAnnounced = true;
    const w = alive[0];
    broadcast({ t: "winner", id: w.id, name: w.name, isBot: w.type === "bot" });
    console.log(`[iron-arena] winner: ${w.id} (${w.name})`);
  }
}, 1000 / TICK);
