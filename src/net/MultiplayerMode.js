// Networked Battle Royale (Phase 14.2 Step 6e): the client controller for the
// SERVER-AUTHORITATIVE Iron Arena match. No longer a dev stepping stone — this is
// the real online experience, reusing the existing Engine + Tank + HUD + Minimap +
// UpgradeHUD + Waiting Room, driven entirely by the authoritative server.
//
//   • local player  — a real Tank (input + camera) with LIGHT client prediction,
//                      softly corrected toward the server.
//   • remote players — Tanks interpolated from snapshots (never simulated locally).
//   • bots           — server-side, rendered identically to remote players.
//   • guardians      — server-side heavy tanks, rendered from the snapshot.
//   • bullets/crates/pickups/fog/walls — authoritative world objects, rendered from
//                      the snapshot; the client draws, the server decides.
//
// The client NEVER decides gameplay outcomes (position/HP/damage/loot/kills/winner
// are all the server's). Flow: lobby (waiting room + countdown) → matchStart → BR →
// death (Killed-By card) / winner (Victory) → lobby, all server-authoritative.

import { Container, Graphics, Text } from "pixi.js";
import { GAME, COLORS, WORLD } from "../config.js";
import { Tank } from "../entities/Tank.js";
import { drawCircle, darken } from "../render/shapes.js";
import { drawUpgradeIcon } from "../render/upgradeIcons.js";
import { RARITY_COLOR } from "../game/upgrades.js";
import { weaponPreviewSvg } from "../ui/weaponPreview.js";
import { hexToCss } from "../ui/dom.js";
import { Hud } from "../ui/Hud.js";
import { Minimap } from "../ui/Minimap.js";
import { UpgradeHud } from "../ui/UpgradeHud.js";
import { NetClient } from "./NetClient.js";
import { AccountClient } from "./AccountClient.js";

const SEND_HZ = 30; // input sends per second
const gradOf = (c) => (c && c.gradient ? [c.gradient[0], c.gradient[1], c.dir] : null);
const GUARDIAN_NAME = 0xb23a3a;

export class MultiplayerMode {
  // callbacks: { onExit(), onWaiting(), onCountdown(s), onMatchStart(), onLobby() }
  constructor(engine, input, profile, callbacks = {}) {
    this.engine = engine;
    this.input = input;
    this.profile = profile;
    this.cb = callbacks;
    this.active = false;
    this.account = new AccountClient(); // persistent {accountId, token} in localStorage

    this.myId = null;
    this.arena = WORLD.waitingBounds.maxX; // lobby arena half-extent until told otherwise
    this.phase = "waiting";
    this.players = new Map(); // id -> { tank, label, tx, ty, trot, ... }
    this.bullets = new Map(); // id -> { g, x, y, vx, vy, shape }
    this.crates = new Map(); // id -> Graphics
    this.pickups = new Map(); // id -> Graphics
    this._sendAcc = 0;

    // World-space layers (rebuilt on lobby/match transitions).
    this.backdrop = null;
    this.wallLayer = null;
    this.fogLayer = null;
    this.beamLayer = null;
    this.crateLayer = null;
    this.pickupLayer = null;
    this.bulletLayer = null;

    // Reused in-world UI (hidden unless a live match is on-screen).
    this.hud = new Hud(engine.app); this.hud.view.visible = false;
    this.minimap = new Minimap(engine.app); this.minimap.view.visible = false;
    this.upgradeHud = new UpgradeHud(engine.app); this.upgradeHud.view.visible = false;
    engine.app.renderer.on("resize", () => { this.hud.layout(); this.minimap.layout(); this.upgradeHud.layout(); });

    engine.addSystem((dt) => this.#tick(dt));
    this.#buildDom();
  }

  // --- lifecycle ------------------------------------------------------------
  start() {
    if (this.active) return;
    this.active = true;

    for (const e of [...this.engine.entities]) e.dead = true; // clear the menu scene
    this.engine.camera.zoom = 1;
    this.#setArena(this.arena);

    this.beamLayer = new Graphics(); this.engine.world.addChild(this.beamLayer);
    this.crateLayer = new Container(); this.engine.world.addChild(this.crateLayer);
    this.pickupLayer = new Container(); this.engine.world.addChild(this.pickupLayer);
    this.bulletLayer = new Container(); this.engine.world.addChild(this.bulletLayer);

    // Local player tank (input + camera = predicted + responsive), equipped weapon.
    const c = GAME.cosmetics[this.profile.cosmetic] || GAME.cosmetics[0];
    const myWeapon = GAME.weapons[this.profile.weapon] || GAME.weapons[0];
    this.localTank = new Tank({
      x: 0, y: 0, input: this.input, camera: this.engine.camera,
      bounds: this.engine.camera.bounds, color: c.color, gradient: gradOf(c),
      wrap: (GAME.wraps[this.profile.wrap] || GAME.wraps[0]).pattern,
      turret: myWeapon.turret || "single",
    });
    this.localTank.team = "me";
    this.engine.addEntity(this.localTank);
    this.engine.camera.follow(this.localTank);
    this.upgradeHud.setLaserMode?.(myWeapon.fireMode === "laser");

    this.overlay.classList.remove("ia-hidden");
    this.#setStatus("connecting…");

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = import.meta.env.VITE_SERVER_URL || `${proto}//${location.hostname}:8080`;
    this.net = new NetClient(url, {
      // Auth handshake first: authenticate the account, adopt the authoritative
      // profile, THEN join with the (server-validated) loadout.
      onOpen: () => { this.#setStatus("authenticating…"); this.net.auth(this.account.authMessage(this.profile.displayName)); },
      onAuthOk: (m) => this.#onAuthOk(m),
      onAuthErr: (m) => this.#onAuthErr(m),
      onProfile: (m) => this.#onProfile(m),
      onWelcome: (m) => this.#onWelcome(m),
      onState: (m) => this.#onState(m),
      onMatchStart: (m) => this.#enterMatch(m.walls || [], m.arena),
      onLobby: () => this.#enterLobby(),
      onKill: (m) => this.#onKillMsg(m),
      onWinner: (m) => this.#onWinnerMsg(m),
      onLeave: (m) => this.#removePlayer(m.id),
      onStatus: (s, d) => this.#onStatus(s, d),
    });
    this._kills = 0;
    this._spawnAt = performance.now();
    this.net.connect();
  }

  // --- account handshake ----------------------------------------------------
  #onAuthOk(m) {
    // Persist creds (a new account issues its token once) and adopt the SERVER's
    // authoritative profile so the menu / Iron Path / cosmetics reflect the account.
    if (m.token) this.account.save(m.accountId, m.token);
    else if (m.accountId) { const c = this.account.load(); this.account.save(m.accountId, c.token); }
    this.profile.applyServerProfile(m.profile);
    this.cb.onProfile?.(); // refresh the main menu readouts (level / currency)
    this.#restyleLocalTank();
    this.#setStatus("connected");
    // Join with the account's (validated) loadout — the server re-validates + spawns.
    const p = this.profile;
    this.net.join({ name: p.displayName, color: p.cosmetic, wrap: p.wrap, trail: p.trail, killFx: p.killFx, title: p.title, weapon: p.weapon });
  }

  #onAuthErr() {
    // Stored creds were rejected (e.g. wiped server / bad token) — drop them and
    // re-auth as a fresh guest account so the player can still play.
    this.account.clear();
    this.net.auth({ name: this.profile.displayName });
  }

  // Post-match (or any) authoritative profile update: refresh the local mirror + menu.
  #onProfile(m) {
    this.profile.applyServerProfile(m.profile);
    this.cb.onProfile?.();
  }

  // Re-style the local tank to the current profile loadout (after auth / validation).
  #restyleLocalTank() {
    const t = this.localTank;
    if (!t) return;
    const c = GAME.cosmetics[this.profile.cosmetic] || GAME.cosmetics[0];
    const w = GAME.weapons[this.profile.weapon] || GAME.weapons[0];
    t.setColor?.(c.color, gradOf(c));
    t.setWrap?.((GAME.wraps[this.profile.wrap] || GAME.wraps[0]).pattern);
    t.setWeapon?.(w);
    this.upgradeHud.setLaserMode?.(w.fireMode === "laser");
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.net?.close();
    for (const p of this.players.values()) p.tank.dead = true;
    this.players.clear();
    this.bullets.clear(); this.crates.clear(); this.pickups.clear();
    if (this.localTank) this.localTank.dead = true;
    this.localTank = null;
    for (const layer of [this.backdrop, this.wallLayer, this.fogLayer, this.beamLayer, this.crateLayer, this.pickupLayer, this.bulletLayer]) layer?.destroy({ children: true });
    this.backdrop = this.wallLayer = this.fogLayer = this.beamLayer = this.crateLayer = this.pickupLayer = this.bulletLayer = null;
    this.hud.view.visible = false;
    this.minimap.view.visible = false;
    this.upgradeHud.view.visible = false;
    this.overlay.classList.add("ia-hidden");
    this.death.classList.add("ia-hidden");
    this.victory.classList.add("ia-hidden");
    this.engine.camera.follow(null);
  }

  // --- phase transitions ----------------------------------------------------
  #enterLobby() {
    this.phase = "waiting";
    this.#setArena(this.arena);
    this.#clearWorldObjects();
    this.hud.view.visible = false;
    this.minimap.view.visible = false;
    this.upgradeHud.view.visible = false;
    this.death.classList.add("ia-hidden");
    this.victory.classList.add("ia-hidden");
    if (this.killerCard) this.killerCard.classList.add("ia-hidden");
    this._dead = false;
    this.cb.onWaiting?.();
  }

  #enterMatch(walls, arena) {
    this.phase = "playing";
    if (arena) this.arena = arena;
    this.#setArena(this.arena);
    this.#drawWalls(walls);
    this.hud.view.visible = true;
    this.minimap.view.visible = true;
    this.upgradeHud.view.visible = true;
    this.upgradeHud.refresh({ normals: {}, specials: [] });
    this._kills = 0; this._spawnAt = performance.now();
    this.death.classList.add("ia-hidden");
    this.victory.classList.add("ia-hidden");
    this.cb.onMatchStart?.();
  }

  // Resize the arena backdrop + camera bounds (lobby is small, the match is full).
  #setArena(arena) {
    this.engine.camera.bounds = { minX: -arena, minY: -arena, maxX: arena, maxY: arena };
    if (this.localTank) this.localTank.bounds = this.engine.camera.bounds;
    if (this.backdrop) this.backdrop.destroy({ children: true });
    this.backdrop = this.#buildBackdrop(arena);
    this.engine.world.addChildAt(this.backdrop, 0);
  }

  #clearWorldObjects() {
    for (const g of this.crates.values()) g.destroy();
    for (const g of this.pickups.values()) g.destroy();
    this.crates.clear(); this.pickups.clear();
    this.wallLayer?.clear();
    this.fogLayer?.clear();
  }

  // --- server messages ------------------------------------------------------
  #onWelcome(m) {
    this.myId = m.id;
    if (m.arena) this.arena = m.arena;
    this.phase = m.phase || "waiting";
    this.#setStatus("connected");
    if (this.phase === "playing") this.#enterMatch(m.walls || [], m.arena);
    else this.#enterLobby();
  }

  #onStatus(state) {
    if (state === "disconnected") this.#setStatus("disconnected — server closed");
    else if (state === "error") this.#setStatus("connection error");
    else if (state === "connecting") this.#setStatus("connecting…");
  }

  #onState(snap) {
    if (!this.active) return;
    if (snap.phase) this.phase = snap.phase;

    // Players (+ bots + guardians): create/update/interp targets.
    const seen = new Set();
    for (const sp of snap.players) {
      seen.add(sp.id);
      if (sp.id === this.myId) { this._serverMe = sp; this._myUp = sp.up; continue; }
      let p = this.players.get(sp.id);
      if (!p) p = this.#addPlayer(sp);
      p.tx = sp.x; p.ty = sp.y; p.trot = sp.rot;
      p.hp = sp.hp; p.maxHp = sp.maxHp; p.alive = sp.alive;
      p.tank.hp = sp.hp; p.tank.maxHp = sp.maxHp;
      p.tank.view.visible = sp.alive;
    }
    for (const id of [...this.players.keys()]) if (!seen.has(id)) this.#removePlayer(id);

    // Bullets (reconcile with the authoritative list).
    const alive = new Set();
    for (const sb of snap.bullets) {
      alive.add(sb.id);
      let b = this.bullets.get(sb.id);
      if (!b) {
        const g = this.#bulletGraphic(sb.shape, sb.radius, sb.g);
        this.bulletLayer.addChild(g);
        b = { g, x: sb.x, y: sb.y, vx: sb.vx, vy: sb.vy, shape: sb.shape || "circle" };
        this.bullets.set(sb.id, b);
      }
      b.x = sb.x; b.y = sb.y; b.vx = sb.vx; b.vy = sb.vy;
    }
    for (const [id, b] of this.bullets) if (!alive.has(id)) { b.g.destroy(); this.bullets.delete(id); }

    // Crates + pickups (authoritative world loot).
    this.#reconcileCrates(snap.crates || []);
    this.#reconcilePickups(snap.pickups || []);

    // Fog ring + laser beams.
    this.#drawFog(snap.fog);
    this.beamLayer.clear();
    for (const sp of snap.players) if (sp.beam) this.beamLayer.moveTo(sp.x, sp.y).lineTo(sp.beam.x, sp.beam.y).stroke({ color: 0xff3b30, width: 5, alpha: 0.85 });

    // Waiting-room countdown.
    if (this.phase === "waiting" && typeof snap.countdown === "number") this.cb.onCountdown?.(Math.max(0, snap.countdown));

    // My HP + death state.
    const me = snap.players.find((p) => p.id === this.myId);
    if (me) {
      this.localTank.hp = me.hp; this.localTank.maxHp = me.maxHp;
      if (me.alive && this._dead) {
        this._spawnAt = performance.now(); this._kills = 0;
        this.death.classList.add("ia-hidden"); this.victory.classList.add("ia-hidden"); this.killerCard.classList.add("ia-hidden");
      } else if (!me.alive && this.phase === "playing") {
        this.death.classList.remove("ia-hidden");
      }
      this._dead = !me.alive;
      this.localTank.view.visible = me.alive;
    }

    // HUD + minimap + my upgrade HUD (only during a live match).
    if (this.phase === "playing" && me) {
      const outside = me.alive && snap.fog && (me.x * me.x + me.y * me.y > snap.fog.r * snap.fog.r);
      this.hud.update({ hp: me.hp, maxHp: me.maxHp, score: 0, alive: snap.alive ?? 0, fps: 0, showFps: false, fogWarning: outside }, 1 / 30);
      const radar = this._myUp?.s?.includes("radar");
      this.minimap.update({
        player: { x: me.x, y: me.y, dead: !me.alive },
        bots: snap.players.filter((p) => p.id !== this.myId && (p.type === "bot" || p.type === "player") && p.alive),
        walls: this._wallBounds || [],
        fogRadius: snap.fog?.r, fogNextRadius: snap.fog?.nr, fogTimer: snap.fog?.ti,
        fogShrinking: snap.fog?.st === "shrinking", fogFinal: snap.fog?.nr == null, radar,
      });
      if (this._myUp) this.upgradeHud.refresh({ normals: this._myUp.n || {}, specials: this._myUp.s || [] });
    }

    let humans = 0, bots = 0;
    for (const sp of snap.players) { if (sp.type === "bot") bots++; else if (sp.type === "player") humans++; }
    this.#updateDebug(humans, bots);
  }

  #addPlayer(sp) {
    const isGuardian = sp.type === "guardian";
    const col = isGuardian ? { color: GAME.guardian.color } : (GAME.cosmetics[sp.color] || GAME.cosmetics[0]);
    const turret = isGuardian ? "single" : (GAME.weapons[sp.weapon] || GAME.weapons[0]).turret || "single";
    const tank = new Tank({ x: sp.x, y: sp.y, color: col.color, gradient: gradOf(col), turret, radius: isGuardian ? (sp.r || GAME.guardian.radius) : undefined, bounds: this.engine.camera.bounds });
    tank.team = sp.id;
    tank.rotation = sp.rot;
    const nameFill = isGuardian ? GUARDIAN_NAME : (sp.type === "bot" ? 0xe0756a : 0xffffff);
    const label = new Text({ text: sp.name, style: { fill: nameFill, fontFamily: "Ubuntu, Arial", fontSize: 13, fontWeight: "bold", stroke: { color: 0x1c2029, width: 3 } } });
    label.anchor.set(0.5);
    label.position.set(0, tank.radius + 20);
    tank.view.addChild(label);
    this.engine.addEntity(tank);
    const p = { tank, label, tx: sp.x, ty: sp.y, trot: sp.rot, hp: sp.hp, maxHp: sp.maxHp, alive: sp.alive };
    this.players.set(sp.id, p);
    return p;
  }

  #removePlayer(id) {
    const p = this.players.get(id);
    if (p) { p.tank.dead = true; this.players.delete(id); }
  }

  // --- world object rendering ----------------------------------------------
  #reconcileCrates(list) {
    const alive = new Set();
    for (const c of list) {
      alive.add(c.id);
      let g = this.crates.get(c.id);
      if (!g) { g = this.#crateGraphic(); this.crateLayer.addChild(g); this.crates.set(c.id, g); }
      g.position.set(c.x, c.y);
    }
    for (const [id, g] of this.crates) if (!alive.has(id)) { g.destroy(); this.crates.delete(id); }
  }

  #reconcilePickups(list) {
    const alive = new Set();
    for (const pk of list) {
      alive.add(pk.id);
      let g = this.pickups.get(pk.id);
      if (!g) { g = this.#pickupGraphic(pk); this.pickupLayer.addChild(g); this.pickups.set(pk.id, g); }
      g.position.set(pk.x, pk.y);
    }
    for (const [id, g] of this.pickups) if (!alive.has(id)) { g.destroy(); this.pickups.delete(id); }
  }

  #crateGraphic() {
    const r = GAME.crate.radius;
    const g = new Graphics();
    g.roundRect(-r, -r, r * 2, r * 2, 8).fill(COLORS.crate).stroke({ color: COLORS.crateEdge, width: 6 });
    g.rect(-r, -r * 0.16, r * 2, r * 0.32).fill(COLORS.crateEdge);
    g.rect(-r * 0.16, -r, r * 0.32, r * 2).fill(COLORS.crateEdge);
    return g;
  }

  #pickupGraphic(pk) {
    const g = new Graphics();
    if (pk.k === "special") {
      // Gold hex + icon (matches the special-pickup look).
      const r = 16, pts = [];
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 - Math.PI / 2; pts.push(Math.cos(a) * r, Math.sin(a) * r); }
      g.poly(pts).fill(0xffd24a).stroke({ color: darken(0xffd24a), width: 3 });
      drawUpgradeIcon(g, pk.t, 0x5a4300, 12);
    } else {
      const col = RARITY_COLOR[pk.r] ?? RARITY_COLOR[0];
      drawCircle(g, 0, 0, 14, col);
      drawUpgradeIcon(g, pk.t, 0xffffff, 12);
    }
    return g;
  }

  #drawWalls(walls) {
    this.wallLayer?.destroy();
    this.wallLayer = new Graphics();
    this.engine.world.addChildAt(this.wallLayer, 1); // above the backdrop, below tanks
    this._wallBounds = [];
    for (const w of walls) {
      this.wallLayer.rect(w.x - w.w / 2, w.y - w.h / 2, w.w, w.h).fill(COLORS.wall).stroke({ color: darken(COLORS.wall), width: 6, alignment: 0 });
      this._wallBounds.push({ minX: w.x - w.w / 2, minY: w.y - w.h / 2, maxX: w.x + w.w / 2, maxY: w.y + w.h / 2 });
    }
  }

  #drawFog(fog) {
    if (!this.fogLayer) { this.fogLayer = new Graphics(); this.engine.world.addChild(this.fogLayer); }
    const g = this.fogLayer.clear();
    if (!fog) return;
    // Safe-zone edge ring + a shaded band just outside it (toxic).
    g.circle(0, 0, fog.r).stroke({ color: GAME.fog.color, width: 8, alpha: 0.5 });
    g.circle(0, 0, fog.r + 6).stroke({ color: GAME.fog.color, width: 3, alpha: 0.9 });
    if (fog.nr != null && fog.nr < fog.r) g.circle(0, 0, fog.nr).stroke({ color: GAME.fog.color, width: 2, alpha: 0.4 });
  }

  // --- per-frame ------------------------------------------------------------
  #tick(dt) {
    if (!this.active) return;

    this._sendAcc += dt;
    if (this.net?.connected && this._sendAcc >= 1 / SEND_HZ) {
      this._sendAcc = 0;
      const mv = this.input.moveAxis();
      const m = this.engine.camera.screenToWorld(this.input.mouse.x, this.input.mouse.y);
      const aim = Math.atan2(m.y - this.localTank.y, m.x - this.localTank.x);
      const fire = !this._dead && this.input.isFiring();
      const detonate = !this._dead && (this.input.isDown("ShiftLeft") || this.input.isDown("ShiftRight"));
      this.net.sendInput(this._dead ? 0 : mv.x, this._dead ? 0 : mv.y, aim, fire, detonate);
    }

    if (this._serverMe && this.localTank) {
      this.localTank.x += (this._serverMe.x - this.localTank.x) * Math.min(1, dt * 6);
      this.localTank.y += (this._serverMe.y - this.localTank.y) * Math.min(1, dt * 6);
    }

    const k = Math.min(1, dt * 12);
    for (const p of this.players.values()) {
      p.tank.x += (p.tx - p.tank.x) * k;
      p.tank.y += (p.ty - p.tank.y) * k;
      p.tank.rotation = this.#lerpAngle(p.tank.rotation, p.trot, k);
    }

    for (const b of this.bullets.values()) {
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.g.position.set(b.x, b.y);
      if (b.shape === "arrow") b.g.rotation = Math.atan2(b.vy, b.vx);
    }
  }

  #bulletGraphic(shape, radius, guardian) {
    const r = radius || GAME.bullet.radius;
    const fill = guardian ? GAME.guardian.color : COLORS.tankBody;
    const g = new Graphics();
    if (shape === "arrow") {
      g.poly([r * 1.25, 0, r * 0.35, -r * 0.95, -r * 0.85, -r * 0.95, -r * 0.85, r * 0.95, r * 0.35, r * 0.95]).fill(fill).stroke({ color: darken(fill), width: 2, alignment: 0.5 });
    } else if (shape === "star") {
      const pts = [];
      for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; const rr = i % 2 ? r * 0.5 : r; pts.push(Math.cos(a) * rr, Math.sin(a) * rr); }
      g.poly(pts).fill(fill).stroke({ color: darken(fill), width: 2, alignment: 0.5 });
    } else {
      drawCircle(g, 0, 0, r, fill);
    }
    return g;
  }

  #lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

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

  // --- dev DOM (status HUD + death/victory overlays + exit) -----------------
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

    this.death = document.createElement("div");
    this.death.className = "ia-mp-death ia-hidden";
    const dcard = document.createElement("div");
    dcard.className = "ia-panel";
    const dh = document.createElement("h2");
    dh.textContent = "YOU DIED";
    this.killerCard = document.createElement("div");
    this.killerCard.className = "ia-killedby ia-hidden";
    this.killerCard.innerHTML =
      `<div class="ia-killedby-label">KILLED BY</div><div class="ia-killedby-art"></div>` +
      `<div class="ia-killedby-name"></div><div class="ia-killedby-title"></div>`;
    this.deathStats = document.createElement("div");
    this.deathStats.className = "ia-note";
    const dnote = document.createElement("div");
    dnote.className = "ia-note";
    dnote.textContent = "Spectating — a new match begins when this round ends.";
    const mb = document.createElement("button");
    mb.className = "ia-btn ia-primary";
    mb.textContent = "Main Menu";
    mb.onclick = () => this.cb.onExit?.();
    dcard.append(dh, this.killerCard, this.deathStats, dnote, mb);
    this.death.append(dcard);

    this.victory = document.createElement("div");
    this.victory.className = "ia-mp-death ia-hidden";
    const vcard = document.createElement("div");
    vcard.className = "ia-panel";
    const vh = document.createElement("h2");
    vh.textContent = "VICTORY";
    vh.style.color = "#ffd24a";
    this.victoryStats = document.createElement("div");
    this.victoryStats.className = "ia-note";
    const vm = document.createElement("button");
    vm.className = "ia-btn ia-primary";
    vm.textContent = "Main Menu";
    vm.onclick = () => this.cb.onExit?.();
    vcard.append(vh, this.victoryStats, vm);
    this.victory.append(vcard);

    document.body.append(this.overlay, this.death, this.victory);
  }

  #onKillMsg(m) {
    if (m.killer === this.myId) this._kills = (this._kills || 0) + 1;
    if (m.victim !== this.myId) return;
    const survival = ((performance.now() - (this._spawnAt || performance.now())) / 1000).toFixed(1);
    this.deathStats.innerHTML = `Survival ${survival}s&nbsp;·&nbsp;Kills ${this._kills || 0}`;
    this.#renderKiller(m.killerInfo);
  }

  #onWinnerMsg(m) {
    if (m.id !== this.myId) return;
    const survival = ((performance.now() - (this._spawnAt || performance.now())) / 1000).toFixed(1);
    this.victoryStats.innerHTML = `Last tank standing&nbsp;·&nbsp;Kills ${this._kills || 0}&nbsp;·&nbsp;${survival}s`;
    this.death.classList.add("ia-hidden");
    this.victory.classList.remove("ia-hidden");
  }

  #renderKiller(info) {
    // Guardians and the fog are text-only (no tank card), matching single-player.
    if (!info || info.isGuardian) {
      const art = this.killerCard.querySelector(".ia-killedby-art");
      if (info?.isGuardian) {
        this.killerCard.querySelector(".ia-killedby-name").textContent = "a Guardian";
        this.killerCard.querySelector(".ia-killedby-title").classList.add("ia-hidden");
        art.innerHTML = "";
        this.killerCard.classList.remove("ia-hidden");
      } else {
        this.killerCard.classList.add("ia-hidden");
      }
      return;
    }
    const c = GAME.cosmetics[info.color] || GAME.cosmetics[0];
    const w = GAME.weapons[info.weapon] || GAME.weapons[0];
    const wrap = (GAME.wraps[info.wrap] || GAME.wraps[0]).pattern;
    this.killerCard.querySelector(".ia-killedby-art").innerHTML = weaponPreviewSvg(w, { color: c.color, gradient: gradOf(c), wrap });
    this.killerCard.querySelector(".ia-killedby-name").textContent = info.name || "";
    const t = GAME.titles[info.title];
    const titleEl = this.killerCard.querySelector(".ia-killedby-title");
    if (t && !t.none && t.name) {
      titleEl.textContent = `[${t.name}]`;
      titleEl.style.color = hexToCss(t.color ?? 0x9aa0b0);
      titleEl.style.fontWeight = t.bold ? "800" : "700";
      titleEl.classList.remove("ia-hidden");
    } else {
      titleEl.classList.add("ia-hidden");
    }
    this.killerCard.classList.remove("ia-hidden");
  }

  #setStatus(text) { this._statusText = text; this.#updateDebug(); }

  #updateDebug(humans, bots) {
    if (humans != null) { this._humans = humans; this._bots = bots; }
    const ping = this.net?.ping ?? 0;
    this.statusEl.innerHTML =
      `<b>ONLINE</b> · ${this.phase}<br>${this._statusText || ""}<br>` +
      `Humans: ${this._humans ?? 1} · Bots: ${this._bots ?? 0}<br>Ping: ${ping}ms`;
  }
}
