// Iron Arena — authoritative multiplayer server (Phase 1 foundation).
//
// The server owns the truth. Clients send INTENT only (move axis, aim angle, fire)
// — never positions, damage, or hit claims. The server simulates a fixed-tick world
// (movement, Standard-turret firing, projectile motion + collisions, damage, death)
// and broadcasts authoritative snapshots. One shared test match; clients that
// connect are dropped straight into it. Reuses the game's real Standard stats from
// src/config.js so client and server agree.
//
// Run:  npm run server   (listens on ws://<host>:8080)

import { WebSocketServer } from "ws";
import { GAME } from "../src/config.js";

const PORT = Number(process.env.PORT) || 8080;
const TICK = 30; // authoritative simulation ticks per second
const DT = 1 / TICK;

// --- authoritative constants (from the real game config, Standard turret) --------
const STD = GAME.weapons[0]; // Standard
const P = {
  speed: GAME.player.speed, // 280
  accel: GAME.player.accel, // 11
  maxHp: GAME.player.maxHp, // 100
  radius: 28,
  cooldown: STD.cooldown, // 0.18s
  bulletSpeed: STD.bulletSpeed, // 780
  bulletLife: STD.bulletLife, // 1.2
  bulletRadius: GAME.bullet.radius, // 7
  damage: STD.shots?.[0]?.damage ?? 15,
  barrel: 28 * 2.2, // muzzle distance (matches Tank.barrelLength)
};
const ARENA = 1400; // arena half-extent (compact so players meet quickly)
const RESPAWN_DELAY = 3; // seconds a dead player waits before it may respawn

// --- match state -----------------------------------------------------------------
const players = new Map(); // id -> player
let bullets = [];
let seqPlayer = 0;
let seqBullet = 0;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function spawnPoint() {
  // Spawn everyone in a tight cluster near the center so players SEE each other
  // immediately on a Phase-1 test (no hunting across a huge arena).
  const a = Math.random() * Math.PI * 2;
  const r = 90 + Math.random() * 160; // 90–250px from center
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

function makePlayer(ws, name, color) {
  const id = `player_${String(++seqPlayer).padStart(3, "0")}`;
  const sp = spawnPoint();
  const pl = {
    id,
    ws,
    name: (typeof name === "string" && name.trim().slice(0, 20)) || id,
    color: num(color, 0),
    x: sp.x,
    y: sp.y,
    vx: 0,
    vy: 0,
    rot: 0,
    hp: P.maxHp,
    maxHp: P.maxHp,
    alive: true,
    weapon: 0, // Standard
    // server-held input intent (never trusted for position)
    input: { mx: 0, my: 0, aim: 0, fire: false },
    fireCd: 0,
    deadAt: 0,
  };
  players.set(id, pl);
  return pl;
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
      const pl = makePlayer(ws, msg.name, msg.color);
      ws.playerId = pl.id;
      // Tell the newcomer who they are + the world parameters.
      send(ws, {
        t: "welcome",
        id: pl.id,
        tick: TICK,
        arena: ARENA,
        config: { speed: P.speed, accel: P.accel, maxHp: P.maxHp, radius: P.radius, bulletRadius: P.bulletRadius, bulletSpeed: P.bulletSpeed, cooldown: P.cooldown },
      });
      console.log(`[iron-arena] ${pl.id} (${pl.name}) joined — ${players.size} player(s)`);
      return;
    }

    const pl = ws.playerId && players.get(ws.playerId);
    if (!pl) return;

    if (msg.t === "input") {
      // INTENT only. Clamp the move axis to a unit disc; aim is a finite angle.
      let mx = clamp(num(msg.mx), -1, 1);
      let my = clamp(num(msg.my), -1, 1);
      const m2 = mx * mx + my * my;
      if (m2 > 1) { const inv = 1 / Math.sqrt(m2); mx *= inv; my *= inv; }
      pl.input.mx = mx;
      pl.input.my = my;
      pl.input.aim = num(msg.aim);
      pl.input.fire = !!msg.fire;
    } else if (msg.t === "respawn") {
      if (!pl.alive && Date.now() / 1000 - pl.deadAt >= RESPAWN_DELAY) {
        const sp = spawnPoint();
        pl.x = sp.x; pl.y = sp.y; pl.vx = 0; pl.vy = 0;
        pl.hp = pl.maxHp; pl.alive = true; pl.fireCd = 0;
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
  if (players.delete(id)) {
    broadcast({ t: "leave", id });
    console.log(`[iron-arena] ${id} left — ${players.size} player(s)`);
  }
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* client went away */ }
  }
}
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const pl of players.values()) {
    if (pl.ws.readyState === pl.ws.OPEN) {
      try { pl.ws.send(s); } catch { /* ignore */ }
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

// --- authoritative simulation ----------------------------------------------------
function step(dt) {
  // Players: integrate INTENT into authoritative motion (no client positions).
  for (const pl of players.values()) {
    if (!pl.alive) continue;
    pl.rot = pl.input.aim;
    const k = 1 - Math.exp(-P.accel * dt);
    pl.vx += (pl.input.mx * P.speed - pl.vx) * k;
    pl.vy += (pl.input.my * P.speed - pl.vy) * k;
    pl.x = clamp(pl.x + pl.vx * dt, -ARENA + P.radius, ARENA - P.radius);
    pl.y = clamp(pl.y + pl.vy * dt, -ARENA + P.radius, ARENA - P.radius);

    if (pl.fireCd > 0) pl.fireCd -= dt;
    if (pl.input.fire && pl.fireCd <= 0) {
      pl.fireCd = P.cooldown;
      bullets.push({
        id: ++seqBullet,
        owner: pl.id,
        x: pl.x + Math.cos(pl.rot) * P.barrel,
        y: pl.y + Math.sin(pl.rot) * P.barrel,
        vx: Math.cos(pl.rot) * P.bulletSpeed,
        vy: Math.sin(pl.rot) * P.bulletSpeed,
        life: P.bulletLife,
        damage: P.damage,
      });
    }
  }

  // Bullets: integrate + authoritative collision. The server — not the client —
  // decides whether a shot connected.
  for (const b of bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    if (b.life <= 0 || Math.abs(b.x) > ARENA || Math.abs(b.y) > ARENA) { b.dead = true; continue; }
    for (const pl of players.values()) {
      if (!pl.alive || pl.id === b.owner) continue;
      const dx = pl.x - b.x;
      const dy = pl.y - b.y;
      const reach = P.radius + P.bulletRadius;
      if (dx * dx + dy * dy <= reach * reach) {
        pl.hp = Math.max(0, pl.hp - b.damage);
        b.dead = true;
        if (pl.hp <= 0) {
          pl.alive = false;
          pl.deadAt = Date.now() / 1000;
          const killer = players.get(b.owner);
          broadcast({ t: "kill", victim: pl.id, killer: killer ? killer.id : null });
          console.log(`[iron-arena] ${b.owner} eliminated ${pl.id}`);
        }
        break;
      }
    }
  }
  bullets = bullets.filter((b) => !b.dead);
}

function snapshot() {
  return {
    t: "state",
    now: Date.now(),
    players: [...players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, rot: Math.round(p.rot * 1000) / 1000, hp: Math.round(p.hp), maxHp: p.maxHp, alive: p.alive, weapon: p.weapon })),
    bullets: bullets.map((b) => ({ id: b.id, owner: b.owner, x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, vx: b.vx, vy: b.vy })),
  };
}

setInterval(() => {
  step(DT);
  if (players.size) broadcast(snapshot());
}, 1000 / TICK);
