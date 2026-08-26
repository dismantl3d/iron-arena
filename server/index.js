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

const PORT = Number(process.env.PORT) || 8080;
const TICK = 30; // authoritative simulation ticks per second
const DT = 1 / TICK;
const RESPAWN_DELAY = 3; // seconds a dead player waits before it may respawn

// --- authoritative world + connection bookkeeping --------------------------------
const world = new WorldModel({
  onKill: ({ victim, killer }) => {
    deadAt.set(victim, Date.now() / 1000);
    broadcast({ t: "kill", victim, killer: killer ?? null });
    console.log(`[iron-arena] ${killer ?? "?"} eliminated ${victim}`);
  },
});
const sockets = new Map(); // id -> ws (which connection owns which entity)
const deadAt = new Map(); // id -> death time (for respawn gating)
let seqPlayer = 0;

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
      world.addEntity({ id, type: "player", team: id, name, color: numColor(msg.color) });
      sockets.set(id, ws);
      ws.playerId = id;
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
      world.setInput(id, { mx: msg.mx, my: msg.my, aim: msg.aim, fire: msg.fire });
    } else if (msg.t === "respawn") {
      const e = world.get(id);
      if (e && !e.alive && Date.now() / 1000 - (deadAt.get(id) ?? 0) >= RESPAWN_DELAY) {
        world.respawn(id);
      }
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
setInterval(() => {
  world.step(DT);
  if (world.entities.size) broadcast({ t: "state", now: Date.now(), ...world.snapshot() });
}, 1000 / TICK);
