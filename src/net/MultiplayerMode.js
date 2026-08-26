// Multiplayer mode (Phase 1): a self-contained client controller that reuses the
// existing Engine + Tank rendering + Input, driven by the AUTHORITATIVE server.
//
//   • local player  — a real Tank (input + camera) moved by LIGHT client prediction
//                      for responsiveness, then softly corrected toward the server.
//   • remote players — Tanks positioned/rotated straight from server snapshots
//                      (interpolated) — never simulated locally.
//   • bullets        — simple views reconciled to the server's authoritative list
//                      and extrapolated between snapshots for smoothness.
//
// It never decides gameplay outcomes (damage/hits/death) — the server does; the
// client only sends intent and renders what the server reports. Runs while the
// single-player Game is paused (GameFlow hands the engine over).

import { Container, Graphics, Text } from "pixi.js";
import { GAME, COLORS } from "../config.js";
import { Tank } from "../entities/Tank.js";
import { drawCircle, darken } from "../render/shapes.js";
import { NetClient } from "./NetClient.js";

const SEND_HZ = 30; // input sends per second
const gradOf = (c) => (c && c.gradient ? [c.gradient[0], c.gradient[1], c.dir] : null);

export class MultiplayerMode {
  // callbacks: { onExit() } — return to the main menu.
  constructor(engine, input, profile, callbacks = {}) {
    this.engine = engine;
    this.input = input;
    this.profile = profile;
    this.cb = callbacks;
    this.active = false;

    this.myId = null;
    this.arena = 1400;
    this.players = new Map(); // id -> { tank, label, tx, ty, trot, hp, maxHp, alive, name, color }
    this.bullets = new Map(); // id -> { g, x, y, vx, vy }
    this._sendAcc = 0;

    // World containers (added on start, destroyed on stop).
    this.backdrop = null;
    this.bulletLayer = null;

    // One persistent system; it no-ops unless this mode is active.
    engine.addSystem((dt) => this.#tick(dt));

    this.#buildDom();
  }

  // --- lifecycle ------------------------------------------------------------
  start() {
    if (this.active) return;
    this.active = true;

    // Take the engine: clear whatever entities the menu had, and pause the SP game.
    for (const e of [...this.engine.entities]) e.dead = true;

    const arena = this.arena;
    this.engine.camera.bounds = { minX: -arena, minY: -arena, maxX: arena, maxY: arena };
    this.engine.camera.zoom = 1;

    // Backdrop (floor + grid + border) behind everything.
    this.backdrop = this.#buildBackdrop(arena);
    this.engine.world.addChildAt(this.backdrop, 0);
    this.bulletLayer = new Container();
    this.engine.world.addChild(this.bulletLayer);

    // Local player tank (input + camera = predicted + responsive).
    const c = GAME.cosmetics[this.profile.cosmetic] || GAME.cosmetics[0];
    this.localTank = new Tank({
      x: 0, y: 0,
      input: this.input,
      camera: this.engine.camera,
      bounds: this.engine.camera.bounds,
      color: c.color,
      gradient: gradOf(c),
      turret: "single", // Standard for the multiplayer foundation
    });
    this.localTank.team = "me";
    this.engine.addEntity(this.localTank);
    this.engine.camera.follow(this.localTank);

    this.overlay.classList.remove("ia-hidden");
    this.#setStatus("connecting…");

    // Server URL: VITE_SERVER_URL wins (production, e.g. wss://play.example.com).
    // Otherwise fall back to the same host on :8080, upgrading to wss:// when the
    // page itself is served over https (so a naive HTTPS deploy still works). No
    // hard-coded localhost in the production build.
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = import.meta.env.VITE_SERVER_URL || `${proto}//${location.hostname}:8080`;
    this.net = new NetClient(url, {
      onWelcome: (m) => this.#onWelcome(m),
      onState: (m) => this.#onState(m),
      onLeave: (m) => this.#removePlayer(m.id),
      onStatus: (s, d) => this.#onStatus(s, d),
    });
    this.net.connect({ name: this.profile.displayName, color: this.profile.cosmetic });
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.net?.close();
    // Tear down all MP entities + world layers.
    for (const p of this.players.values()) p.tank.dead = true;
    this.players.clear();
    this.bullets.clear();
    if (this.localTank) this.localTank.dead = true;
    this.localTank = null;
    if (this.backdrop) this.backdrop.destroy({ children: true });
    if (this.bulletLayer) this.bulletLayer.destroy({ children: true });
    this.backdrop = this.bulletLayer = null;
    this.overlay.classList.add("ia-hidden");
    this.death.classList.add("ia-hidden");
    this.engine.camera.follow(null);
  }

  // --- server messages ------------------------------------------------------
  #onWelcome(m) {
    this.myId = m.id;
    this.arena = m.arena ?? this.arena;
    this.#setStatus("connected");
  }

  #onStatus(state) {
    if (state === "disconnected") this.#setStatus("disconnected — server closed");
    else if (state === "error") this.#setStatus("connection error");
    else if (state === "connecting") this.#setStatus("connecting…");
  }

  #onState(snap) {
    if (!this.active) return;
    // Players: create/update/interp targets.
    const seen = new Set();
    for (const sp of snap.players) {
      seen.add(sp.id);
      if (sp.id === this.myId) {
        // Authoritative correction of the local (predicted) tank.
        this._serverMe = sp;
        continue;
      }
      let p = this.players.get(sp.id);
      if (!p) p = this.#addPlayer(sp);
      p.tx = sp.x; p.ty = sp.y; p.trot = sp.rot;
      p.hp = sp.hp; p.maxHp = sp.maxHp; p.alive = sp.alive; p.name = sp.name;
      p.tank.hp = sp.hp; p.tank.maxHp = sp.maxHp;
      p.tank.view.visible = sp.alive;
    }
    for (const id of [...this.players.keys()]) if (!seen.has(id)) this.#removePlayer(id);

    // Bullets: reconcile with the authoritative list.
    const alive = new Set();
    for (const sb of snap.bullets) {
      alive.add(sb.id);
      let b = this.bullets.get(sb.id);
      if (!b) {
        const g = drawCircle(new Graphics(), 0, 0, GAME.bullet.radius, COLORS.tankBody);
        this.bulletLayer.addChild(g);
        b = { g, x: sb.x, y: sb.y, vx: sb.vx, vy: sb.vy };
        this.bullets.set(sb.id, b);
      }
      b.x = sb.x; b.y = sb.y; b.vx = sb.vx; b.vy = sb.vy; // snap to authority
    }
    for (const [id, b] of this.bullets) if (!alive.has(id)) { b.g.destroy(); this.bullets.delete(id); }

    // My HP + death state (drives the death overlay).
    const me = snap.players.find((p) => p.id === this.myId);
    if (me) {
      this.localTank.hp = me.hp; this.localTank.maxHp = me.maxHp;
      this.death.classList.toggle("ia-hidden", me.alive);
      this._dead = !me.alive;
    }
    this.#updateDebug(snap.players.length);
  }

  #addPlayer(sp) {
    const col = GAME.cosmetics[sp.color] || GAME.cosmetics[0];
    const tank = new Tank({ x: sp.x, y: sp.y, color: col.color, gradient: gradOf(col), turret: "single", bounds: this.engine.camera.bounds });
    tank.team = sp.id;
    tank.rotation = sp.rot;
    const label = new Text({ text: sp.name, style: { fill: 0xffffff, fontFamily: "Ubuntu, Arial", fontSize: 13, fontWeight: "bold", stroke: { color: 0x1c2029, width: 3 } } });
    label.anchor.set(0.5);
    label.position.set(0, tank.radius + 20);
    tank.view.addChild(label);
    this.engine.addEntity(tank);
    const p = { tank, label, tx: sp.x, ty: sp.y, trot: sp.rot, hp: sp.hp, maxHp: sp.maxHp, alive: sp.alive, name: sp.name, color: sp.color };
    this.players.set(sp.id, p);
    return p;
  }

  #removePlayer(id) {
    const p = this.players.get(id);
    if (p) { p.tank.dead = true; this.players.delete(id); }
  }

  // --- per-frame ------------------------------------------------------------
  #tick(dt) {
    if (!this.active) return;

    // Send INPUT INTENT (throttled). Aim comes from the cursor in world space.
    this._sendAcc += dt;
    if (this.net?.connected && this._sendAcc >= 1 / SEND_HZ) {
      this._sendAcc = 0;
      const mv = this.input.moveAxis();
      const m = this.engine.camera.screenToWorld(this.input.mouse.x, this.input.mouse.y);
      const aim = Math.atan2(m.y - this.localTank.y, m.x - this.localTank.x);
      // Don't move/fire while dead (server ignores it anyway, but be tidy).
      const fire = !this._dead && this.input.isFiring();
      this.net.sendInput(this._dead ? 0 : mv.x, this._dead ? 0 : mv.y, aim, fire);
    }

    // Soft-correct the local predicted tank toward the server's authoritative pos.
    if (this._serverMe && this.localTank) {
      this.localTank.x += (this._serverMe.x - this.localTank.x) * Math.min(1, dt * 6);
      this.localTank.y += (this._serverMe.y - this.localTank.y) * Math.min(1, dt * 6);
    }

    // Remote players: smoothly interpolate toward their latest server transform.
    const k = Math.min(1, dt * 12);
    for (const p of this.players.values()) {
      p.tank.x += (p.tx - p.tank.x) * k;
      p.tank.y += (p.ty - p.tank.y) * k;
      p.tank.rotation = this.#lerpAngle(p.tank.rotation, p.trot, k);
    }

    // Bullets: extrapolate between snapshots for smooth motion.
    for (const b of this.bullets.values()) {
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.g.position.set(b.x, b.y);
    }
  }

  #lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  // --- world backdrop -------------------------------------------------------
  #buildBackdrop(arena) {
    const c = new Container();
    const floor = new Graphics();
    floor.rect(-arena, -arena, arena * 2, arena * 2).fill(COLORS.arenaFloor).stroke({ color: COLORS.arenaBorder, width: 8 });
    const grid = new Graphics();
    const step = 120;
    for (let x = -arena; x <= arena; x += step) grid.moveTo(x, -arena).lineTo(x, arena);
    for (let y = -arena; y <= arena; y += step) grid.moveTo(-arena, y).lineTo(arena, y);
    grid.stroke({ color: COLORS.grid, width: 2 });
    c.addChild(floor, grid);
    return c;
  }

  // --- dev DOM (status HUD + death overlay + exit) --------------------------
  #buildDom() {
    this.statusEl = document.createElement("div");
    this.statusEl.className = "ia-mp-status";
    this.exitBtn = document.createElement("button");
    this.exitBtn.className = "ia-btn ia-mp-exit";
    this.exitBtn.textContent = "Leave";
    this.exitBtn.onclick = () => this.cb.onExit?.();
    this.overlay = document.createElement("div");
    this.overlay.className = "ia-mp-overlay ia-hidden";
    this.overlay.append(this.statusEl, this.exitBtn);

    // Death overlay with a Respawn button.
    this.death = document.createElement("div");
    this.death.className = "ia-mp-death ia-hidden";
    const dcard = document.createElement("div");
    dcard.className = "ia-panel";
    const dh = document.createElement("h2");
    dh.textContent = "YOU DIED";
    const rb = document.createElement("button");
    rb.className = "ia-btn ia-primary";
    rb.textContent = "Respawn";
    rb.onclick = () => this.net?.requestRespawn();
    const mb = document.createElement("button");
    mb.className = "ia-btn";
    mb.textContent = "Main Menu";
    mb.onclick = () => this.cb.onExit?.();
    dcard.append(dh, rb, mb);
    this.death.append(dcard);

    document.body.append(this.overlay, this.death);
  }

  #setStatus(text) { this._statusText = text; this.#updateDebug(); }

  #updateDebug(count) {
    if (count != null) this._count = count;
    const ping = this.net?.ping ?? 0;
    this.statusEl.innerHTML =
      `<b>MULTIPLAYER (dev)</b><br>${this._statusText || ""}<br>` +
      `ID: ${this.myId || "—"}<br>Players: ${this._count ?? 1}<br>Ping: ${ping}ms`;
  }
}
