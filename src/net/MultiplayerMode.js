// Networked Battle Royale (Phase 14.2 Step 6e + Step 7). The client controller for
// the SERVER-AUTHORITATIVE Iron Arena match. It renders the online world using the
// EXACT SAME components as the offline game (Tank, UpgradePickup, Crate, Wall, the
// arena grid/floor/border, the Fog edge, Particle/DamageNumber FX, and the real
// DeathScreen/WinnerScreen) so online looks identical to offline — only the source
// of truth differs (server snapshots instead of a local sim).
//
//   • local player  — a real Tank (input + camera) with light client prediction.
//   • remote players/bots/guardians — Tanks interpolated from snapshots.
//   • world objects  — pickups/crates/walls/fog rendered from the snapshot with the
//                      offline entities/renderers.
//   • combat FX      — muzzle flash, hit sparks, damage numbers, kill FX, crate/death
//                      bursts, movement trail, and distance-based camera shake, all
//                      DERIVED from snapshot deltas + authoritative kill events.
//
// The client never decides gameplay outcomes; it only sends intent and draws what the
// server reports (accounts: it authenticates + mirrors the authoritative profile).

import { Container, Graphics, Text } from "pixi.js";
import { GAME, COLORS, WORLD } from "../config.js";
import { Tank } from "../entities/Tank.js";
import { UpgradePickup } from "../entities/UpgradePickup.js";
import { Crate } from "../entities/Crate.js";
import { Wall } from "../entities/Wall.js";
import { Particle } from "../entities/Particle.js";
import { DamageNumber } from "../entities/DamageNumber.js";
import { drawCircle, darken } from "../render/shapes.js";
import { createGrid } from "../render/Grid.js";
import { createArenaFloor, createArenaBorder } from "../render/Arena.js";
import { Hud } from "../ui/Hud.js";
import { Minimap } from "../ui/Minimap.js";
import { UpgradeHud } from "../ui/UpgradeHud.js";
import { DeathScreen } from "../ui/DeathScreen.js";
import { WinnerScreen } from "../ui/WinnerScreen.js";
import { NetClient } from "./NetClient.js";
import { AccountClient } from "./AccountClient.js";

const SEND_HZ = 30; // input sends per second
const gradOf = (c) => (c && c.gradient ? [c.gradient[0], c.gradient[1], c.dir] : null);
const HSV = [0xff5555, 0xffa53a, 0xffd24a, 0x76d672, 0x4aa3ff, 0x9b6cff]; // rainbow trail
const NAME_STROKE = { color: 0x1c2029, width: 3, join: "round" };
const ENEMY_NAME = 0xff8a8a;
const GUARDIAN_NAME = 0xb23a3a;

export class MultiplayerMode {
  // callbacks: { onExit(), onWaiting(), onCountdown(s), onMatchStart(), onLobby(), onProfile() }
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
    this.players = new Map(); // id -> { tank, label, titleLabel, tx, ty, trot, hp, color, ... }
    this.bullets = new Map(); // id -> { g, x, y, vx, vy, shape }
    this.crates = new Map(); // id -> Crate entity
    this.pickups = new Map(); // id -> UpgradePickup entity
    this.wallEntities = [];
    this._hp = new Map(); // id -> last seen hp (for hit-spark / damage-number FX)
    this._sendAcc = 0;
    this._seq = 0; // outgoing input sequence number
    this._ack = 0; // latest input seq the server has processed for us
    this._trailCd = 0;
    this._rainbow = 0;

    // World-space layers (rebuilt on lobby/match transitions).
    this.backdrop = null;
    this.fogLayer = null;
    this.beamLayer = null;
    this.bulletLayer = null;

    // Reused in-world UI (hidden unless a live match is on-screen).
    this.hud = new Hud(engine.app); this.hud.view.visible = false;
    this.minimap = new Minimap(engine.app); this.minimap.view.visible = false;
    this.upgradeHud = new UpgradeHud(engine.app); this.upgradeHud.view.visible = false;
    engine.app.renderer.on("resize", () => { this.hud.layout(); this.minimap.layout(); this.upgradeHud.layout(); });

    // The REAL death / winner screens (identical to offline). Online has no immediate
    // restart, so PLAY AGAIN is hidden — only MAIN MENU (exits online).
    this.death = new DeathScreen({ onMenu: () => this.cb.onExit?.(), onPlayAgain: () => {} });
    this.winner = new WinnerScreen({ onMenu: () => this.cb.onExit?.(), onPlayAgain: () => {} });

    engine.addSystem((dt) => this.#tick(dt));
    this.#buildDom();
  }

  // --- lifecycle ------------------------------------------------------------
  start() {
    if (this.active) return;
    this.active = true;

    for (const e of [...this.engine.entities]) e.dead = true; // clear the menu scene
    this.engine.camera.zoom = 1;
    this.engine.camera.followSpeed = GAME.camera.followSpeed;
    this.engine.camera.shakeDecay = GAME.camera.shakeDecay;
    this.engine.camera.shakeMax = GAME.camera.shakeMax;
    this.#setArena(this.arena);

    this.fogLayer = new Graphics(); this.engine.world.addChild(this.fogLayer);
    this.beamLayer = new Graphics(); this.engine.world.addChild(this.beamLayer);
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
      onOpen: () => { this.#setStatus("authenticating…"); this.net.auth(this.account.authMessage(this.profile.displayName, this.profile.ironPathXp)); },
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
    this._dead = false;
    this._welcomed = false;
    // Offline fallback (dev mechanism): if no server answers, PLAY falls back to the
    // local Battle Royale. Fire onConnectFailed if we don't get a welcome in time.
    this._connTimer = setTimeout(() => { if (!this._welcomed) this.#connectFailed(); }, 2500);
    this.net.connect();
  }

  #connectFailed() {
    if (!this.active || this._welcomed || this._failed) return;
    this._failed = true;
    clearTimeout(this._connTimer);
    this.cb.onConnectFailed?.();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this._failed = false;
    clearTimeout(this._connTimer);
    this.net?.close();
    for (const p of this.players.values()) p.tank.dead = true;
    this.players.clear();
    for (const c of this.crates.values()) c.dead = true;
    for (const p of this.pickups.values()) p.dead = true;
    for (const w of this.wallEntities) w.dead = true;
    this.crates.clear(); this.pickups.clear(); this.wallEntities = [];
    this.bullets.clear(); this._hp.clear();
    if (this.localTank) this.localTank.dead = true;
    this.localTank = null;
    for (const layer of [this.backdrop, this.fogLayer, this.beamLayer, this.bulletLayer]) layer?.destroy({ children: true });
    this.backdrop = this.fogLayer = this.beamLayer = this.bulletLayer = null;
    this.hud.view.visible = false;
    this.minimap.view.visible = false;
    this.upgradeHud.view.visible = false;
    this.overlay.classList.add("ia-hidden");
    this.death.hide();
    this.winner.hide();
    this.engine.camera.follow(null);
    this.engine.camera.zoom = 1;
  }

  // --- account handshake ----------------------------------------------------
  #onAuthOk(m) {
    if (m.token) this.account.save(m.accountId, m.token);
    else if (m.accountId) { const c = this.account.load(); this.account.save(m.accountId, c.token); }
    this.profile.applyServerProfile(m.profile);
    this.cb.onProfile?.();
    this.#restyleLocalTank();
    this.#setStatus("connected");
    const p = this.profile;
    this.net.join({ name: p.displayName, color: p.cosmetic, wrap: p.wrap, trail: p.trail, killFx: p.killFx, title: p.title, weapon: p.weapon });
  }

  #onAuthErr() {
    this.account.clear();
    this.net.auth({ name: this.profile.displayName });
  }

  #onProfile(m) {
    this._lastReward = m.reward || this._lastReward;
    this.profile.applyServerProfile(m.profile);
    this.cb.onProfile?.();
  }

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

  // --- phase transitions ----------------------------------------------------
  #enterLobby() {
    this.phase = "waiting";
    this.#setArena(this.arena);
    this.#clearWorldObjects();
    this.hud.view.visible = false;
    this.minimap.view.visible = false;
    this.upgradeHud.view.visible = false;
    this.death.hide();
    this.winner.hide();
    this._dead = false;
    this.cb.onWaiting?.();
  }

  #enterMatch(walls, arena) {
    this.phase = "playing";
    if (arena) this.arena = arena;
    this.#setArena(this.arena);
    this.#buildWalls(walls);
    this.hud.view.visible = true;
    this.minimap.view.visible = true;
    this.upgradeHud.view.visible = true;
    this.upgradeHud.refresh({ normals: {}, specials: [] });
    this._kills = 0; this._spawnAt = performance.now(); this._dead = false;
    this.death.hide();
    this.winner.hide();
    this.cb.onMatchStart?.();
  }

  // Resize the arena backdrop (reuses the OFFLINE grid/floor/border so it matches).
  #setArena(arena) {
    this.engine.camera.bounds = { minX: -arena, minY: -arena, maxX: arena, maxY: arena };
    if (this.localTank) this.localTank.bounds = this.engine.camera.bounds;
    if (this.backdrop) this.backdrop.destroy({ children: true });
    this.backdrop = this.#buildBackdrop(this.engine.camera.bounds);
    this.engine.world.addChildAt(this.backdrop, 0);
  }

  #clearWorldObjects() {
    for (const c of this.crates.values()) c.dead = true;
    for (const p of this.pickups.values()) p.dead = true;
    for (const w of this.wallEntities) w.dead = true;
    this.crates.clear(); this.pickups.clear(); this.wallEntities = [];
    this._wallBounds = [];
    this.fogLayer?.clear();
  }

  // --- server messages ------------------------------------------------------
  #onWelcome(m) {
    this._welcomed = true;
    clearTimeout(this._connTimer);
    this.myId = m.id;
    this.lobby = m.lobby;
    if (m.arena) this.arena = m.arena;
    this.phase = m.phase || "waiting";
    this.#setStatus("connected");
    // Restyle the local tank to the SERVER-VALIDATED loadout so the local player looks
    // exactly like what other players see (authoritative appearance).
    if (m.loadout) this.#styleLocalTank(m.loadout);
    if (this.phase === "playing") this.#enterMatch(m.walls || [], m.arena);
    else this.#enterLobby();
  }

  // Style the local tank from explicit loadout indices (the server-validated set).
  #styleLocalTank(L) {
    const t = this.localTank;
    if (!t || !L) return;
    const c = GAME.cosmetics[L.cosmetic] || GAME.cosmetics[0];
    const w = GAME.weapons[L.weapon] || GAME.weapons[0];
    t.setColor?.(c.color, gradOf(c));
    t.setWrap?.((GAME.wraps[L.wrap] || GAME.wraps[0]).pattern);
    t.setWeapon?.(w);
    this._localTrail = L.trail ?? 0; // used by #emitTrail for the local player
    this._localKillFx = L.killFx ?? 0;
    this.upgradeHud.setLaserMode?.(w.fireMode === "laser");
  }

  #onStatus(state) {
    // Before a welcome, a socket error / early close means "no server" → offline fallback.
    if (!this._welcomed && (state === "error" || state === "disconnected")) { this.#connectFailed(); return; }
    if (state === "disconnected") this.#setStatus("disconnected — server closed");
    else if (state === "error") this.#setStatus("connection error");
    else if (state === "connecting") this.#setStatus("connecting…");
  }

  #onState(snap) {
    if (!this.active) return;
    if (snap.phase) this.phase = snap.phase;
    if (typeof snap.ack === "number") this._ack = snap.ack; // latest input the server applied

    // Players (+ bots + guardians): create/update/interp targets + hit-FX from hp deltas.
    const seen = new Set();
    for (const sp of snap.players) {
      seen.add(sp.id);
      this.#hitFx(sp); // hit sparks + damage numbers from authoritative hp drops
      if (sp.id === this.myId) { this._serverMe = sp; this._myUp = sp.up; continue; }
      let p = this.players.get(sp.id);
      if (!p) p = this.#addPlayer(sp);
      p.tx = sp.x; p.ty = sp.y; p.trot = sp.rot;
      p.hp = sp.hp; p.maxHp = sp.maxHp; p.alive = sp.alive; p.color = sp.color;
      p.trail = sp.trail ?? 0; // equipped trail (for remote trail FX)
      p.tank.hp = sp.hp; p.tank.maxHp = sp.maxHp;
      p.tank.view.visible = sp.alive;
    }
    for (const id of [...this.players.keys()]) if (!seen.has(id)) this.#removePlayer(id);

    // Bullets (reconcile) + muzzle flash for the LOCAL player's new shots (offline
    // only the player muzzle-flashes).
    const alive = new Set();
    for (const sb of snap.bullets) {
      alive.add(sb.id);
      let b = this.bullets.get(sb.id);
      if (!b) {
        const g = this.#bulletGraphic(sb.shape, sb.radius, sb.g);
        this.bulletLayer.addChild(g);
        b = { g, x: sb.x, y: sb.y, vx: sb.vx, vy: sb.vy, shape: sb.shape || "circle" };
        this.bullets.set(sb.id, b);
        if (sb.owner === this.myId) this.#muzzleFlash(sb.x, sb.y, Math.atan2(sb.vy, sb.vx));
      }
      b.x = sb.x; b.y = sb.y; b.vx = sb.vx; b.vy = sb.vy;
    }
    for (const [id, b] of this.bullets) if (!alive.has(id)) { b.g.destroy(); this.bullets.delete(id); }

    // Crates + pickups (authoritative world loot) via the real entities.
    this.#reconcileCrates(snap.crates || []);
    this.#reconcilePickups(snap.pickups || []);

    // Fog ring (offline edge) + laser beams.
    this.#drawFog(snap.fog);
    this.beamLayer.clear();
    for (const sp of snap.players) if (sp.beam) this.beamLayer.moveTo(sp.x, sp.y).lineTo(sp.beam.x, sp.beam.y).stroke({ color: 0xff3b30, width: 5, alpha: 0.85 });

    if (this.phase === "waiting" && typeof snap.countdown === "number") this.cb.onCountdown?.(Math.max(0, snap.countdown));

    // My HP + death/respawn state.
    const me = snap.players.find((p) => p.id === this.myId);
    if (me) {
      this.localTank.hp = me.hp; this.localTank.maxHp = me.maxHp;
      if (me.alive && this._dead) { this._spawnAt = performance.now(); this._kills = 0; this._dead = false; this.death.hide(); this.winner.hide(); }
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

  // Hit FX from an authoritative HP drop (bullet/laser hits). A small threshold skips
  // the fog's per-tick chip so only real hits pop a spark + damage number (offline
  // shows damage numbers on bullet hits, not fog ticks).
  #hitFx(sp) {
    const prev = this._hp.get(sp.id);
    this._hp.set(sp.id, sp.hp);
    if (prev == null || !sp.alive) return;
    const dmg = prev - sp.hp;
    if (dmg >= 2) {
      const radius = sp.type === "guardian" ? GAME.guardian.radius : 28;
      this.#burst(sp.x, sp.y, COLORS.hitSpark, 5);
      this.#damageNumber(sp.x, sp.y - radius, dmg);
    }
  }

  #addPlayer(sp) {
    const isGuardian = sp.type === "guardian";
    const col = isGuardian ? { color: GAME.guardian.color } : (GAME.cosmetics[sp.color] || GAME.cosmetics[0]);
    const turret = isGuardian ? "single" : (GAME.weapons[sp.weapon] || GAME.weapons[0]).turret || "single";
    const wrap = isGuardian ? "none" : (GAME.wraps[sp.wrap ?? 0] || GAME.wraps[0]).pattern;
    const tank = new Tank({ x: sp.x, y: sp.y, color: col.color, gradient: gradOf(col), wrap, turret, radius: isGuardian ? (sp.r || GAME.guardian.radius) : undefined, bounds: this.engine.camera.bounds });
    tank.team = sp.id;
    tank.rotation = sp.rot;
    // Title label above the name (matches offline). Guardians show only "GUARDIAN".
    let titleLabel = null;
    if (!isGuardian) {
      const title = GAME.titles[sp.title ?? 0] || GAME.titles[0];
      if (!title.none) {
        titleLabel = new Text({ text: `[${title.name}]`, style: { fill: title.color ?? COLORS.xpFill, fontFamily: "Ubuntu, Arial", fontSize: 12, fontWeight: title.bold ? "bold" : "normal", stroke: NAME_STROKE } });
        titleLabel.anchor.set(0.5); titleLabel.position.set(0, tank.radius + 16);
        tank.view.addChild(titleLabel);
      }
    }
    const nameFill = isGuardian ? GUARDIAN_NAME : (sp.type === "bot" ? ENEMY_NAME : 0xffffff);
    const label = new Text({ text: sp.name, style: { fill: nameFill, fontFamily: "Ubuntu, Arial", fontSize: 13, fontWeight: "bold", stroke: NAME_STROKE } });
    label.anchor.set(0.5);
    label.position.set(0, tank.radius + (titleLabel ? 33 : 20));
    tank.view.addChild(label);
    this.engine.addEntity(tank);
    const p = { tank, label, titleLabel, tx: sp.x, ty: sp.y, trot: sp.rot, hp: sp.hp, maxHp: sp.maxHp, alive: sp.alive, color: sp.color };
    this.players.set(sp.id, p);
    return p;
  }

  #removePlayer(id) {
    const p = this.players.get(id);
    if (p) { p.tank.dead = true; this.players.delete(id); }
    this._hp.delete(id);
  }

  // --- world object rendering (real offline entities) -----------------------
  #reconcileCrates(list) {
    const alive = new Set();
    for (const c of list) {
      alive.add(c.id);
      let e = this.crates.get(c.id);
      if (!e) { e = new Crate({ x: c.x, y: c.y, rarity: 0, items: [] }); this.engine.addEntity(e); this.crates.set(c.id, e); }
      e.x = c.x; e.y = c.y;
    }
    for (const [id, e] of this.crates) if (!alive.has(id)) {
      this.#crateBurst(e.x, e.y); this.#shakeAt(e.x, e.y, 6); // a crate broke
      e.dead = true; this.crates.delete(id);
    }
  }

  #reconcilePickups(list) {
    const alive = new Set();
    const ownNormals = this._myUp?.n || {};
    const ownSpecials = this._myUp?.s || [];
    for (const pk of list) {
      alive.add(pk.id);
      let e = this.pickups.get(pk.id);
      if (!e) { e = new UpgradePickup({ x: pk.x, y: pk.y, kind: pk.k, typeKey: pk.t, rarity: pk.r }); this.engine.addEntity(e); this.pickups.set(pk.id, e); }
      e.x = pk.x; e.y = pk.y;
      // Ghost (translucent) if the LOCAL player already owns it — like offline.
      e.ghost = pk.k === "special" ? ownSpecials.includes(pk.t) : (ownNormals[pk.t] !== undefined && ownNormals[pk.t] >= pk.r);
    }
    for (const [id, e] of this.pickups) if (!alive.has(id)) { e.dead = true; this.pickups.delete(id); }
  }

  #buildWalls(walls) {
    for (const w of this.wallEntities) w.dead = true;
    this.wallEntities = [];
    this._wallBounds = [];
    for (const w of walls) {
      const wall = new Wall({ x: w.x, y: w.y, w: w.w, h: w.h });
      this.engine.addEntity(wall);
      this.wallEntities.push(wall);
      this._wallBounds.push({ minX: wall.minX, minY: wall.minY, maxX: wall.maxX, maxY: wall.maxY });
    }
  }

  // Fog edge, matching offline Fog#draw exactly (hazy band + crisp edge).
  #drawFog(fog) {
    const g = this.fogLayer.clear();
    if (!fog) return;
    g.circle(0, 0, fog.r).stroke({ color: GAME.fog.color, width: 60, alpha: 0.28 }) // hazy band
      .circle(0, 0, fog.r).stroke({ color: GAME.fog.color, width: 6, alpha: 0.9 }); // crisp edge
  }

  // --- combat FX (ported from Game.js so online looks/feels identical) -------
  #burst(x, y, color, count) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 80 + Math.random() * 170;
      this.engine.addEntity(new Particle({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, radius: 3 + Math.random() * 3, color, life: 0.3 + Math.random() * 0.25 }));
    }
  }

  #muzzleFlash(x, y, angle) {
    for (let i = 0; i < 4; i++) {
      const a = angle + (Math.random() - 0.5) * 0.5;
      const s = 120 + Math.random() * 130;
      this.engine.addEntity(new Particle({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, radius: 2 + Math.random() * 2, color: 0xfff2c0, life: 0.1 + Math.random() * 0.08 }));
    }
  }

  #damageNumber(x, y, amount) {
    this.engine.addEntity(new DamageNumber({ x, y, amount: Math.round(amount) }));
  }

  #crateBurst(x, y) {
    this.#burst(x, y, COLORS.crate, 16);
    this.#burst(x, y, COLORS.crateEdge, 10);
  }

  // The KILLER's equipped kill FX at a defeated tank. `killFxIndex` is the killer's
  // synchronized kill-FX id (from the authoritative kill event) so every player's
  // kill FX renders correctly on every client, using the existing kill-FX system.
  #killEffect(x, y, color, killFxIndex) {
    const fx = GAME.killFx[killFxIndex ?? 0]?.fx || "none";
    if (fx === "none") return;
    if (fx === "stars") {
      for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; this.engine.addEntity(new Particle({ x, y, vx: Math.cos(a) * 200, vy: Math.sin(a) * 200, radius: 4, color: 0xffd24a, life: 0.6 })); }
    } else if (fx === "explosion") {
      this.#burst(x, y, 0xffa53a, 22); this.#burst(x, y, 0xe2564b, 14); this.engine.camera.shake(8);
    } else if (fx === "dissolve") {
      for (let i = 0; i < 16; i++) { const a = Math.random() * Math.PI * 2, s = 30 + Math.random() * 60; this.engine.addEntity(new Particle({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, radius: 3, color, life: 0.8 })); }
    } else { this.#burst(x, y, color, 16); }
  }

  // Distance-based camera shake (the preserved per-player fix): full within shakeNear,
  // linear to zero at shakeFar, silent across the map.
  #shakeAt(x, y, amount) {
    const p = this.localTank;
    if (!p) return;
    const d = Math.hypot(x - p.x, y - p.y);
    const near = GAME.camera.shakeNear, far = GAME.camera.shakeFar;
    if (d >= far) return;
    const f = d <= near ? 1 : 1 - (d - near) / (far - near);
    const amt = amount * f;
    if (amt > 0.3) this.engine.camera.shake(amt);
  }

  // Cosmetic movement trail behind ANY tank with a trail equipped (local + remote),
  // using the SAME trail styles as offline. Movement is measured by position delta so
  // it works for the predicted local tank and interpolated remote tanks alike.
  #emitTrailFor(tank, trailIndex, dt) {
    if (!tank || tank.view.visible === false) return;
    const def = GAME.trails[trailIndex ?? 0];
    if (!def || def.style === "none") return;
    const lx = tank._tlx ?? tank.x, ly = tank._tly ?? tank.y;
    const moved = Math.hypot(tank.x - lx, tank.y - ly);
    tank._tlx = tank.x; tank._tly = tank.y;
    if (moved / Math.max(dt, 1 / 120) < 40) return; // speed threshold (units/sec)
    tank._trailCd = (tank._trailCd ?? 0) - dt;
    if (tank._trailCd > 0) return;
    tank._trailCd = 0.05;
    const bx = tank.x - Math.cos(tank.rotation) * tank.radius, by = tank.y - Math.sin(tank.rotation) * tank.radius;
    if (def.style === "trueSparks") {
      const cols = [0xffd24a, 0xff8a3a, 0x9aa0a6];
      for (let i = 0; i < 3; i++) { const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 140; this.engine.addEntity(new Particle({ x: bx, y: by, vx: Math.cos(a) * s, vy: Math.sin(a) * s, radius: 2 + Math.random() * 2, color: cols[(Math.random() * cols.length) | 0], life: 0.28 + Math.random() * 0.22 })); }
      return;
    }
    let color = def.color ?? tank.color;
    if (def.style === "rainbow") color = HSV[(this._rainbow = (this._rainbow + 1) % HSV.length)];
    const radius = def.style === "squares" ? 5 : def.style === "spark" ? 3 : def.style === "hologram" ? 6 : 7;
    this.engine.addEntity(new Particle({ x: bx, y: by, vx: 0, vy: 0, radius, color, life: def.style === "smoke" ? 0.6 : def.style === "hologram" ? 0.5 : 0.4 }));
  }

  // --- per-frame ------------------------------------------------------------
  #tick(dt) {
    if (!this.active) return;

    this._sendAcc += dt;
    if (this.net?.connected && this.localTank && this._sendAcc >= 1 / SEND_HZ) {
      this._sendAcc = 0;
      const mv = this.input.moveAxis();
      const m = this.engine.camera.screenToWorld(this.input.mouse.x, this.input.mouse.y);
      const aim = Math.atan2(m.y - this.localTank.y, m.x - this.localTank.x);
      const fire = !this._dead && this.input.isFiring();
      const detonate = !this._dead && (this.input.isDown("ShiftLeft") || this.input.isDown("ShiftRight"));
      this.net.sendInput(this._dead ? 0 : mv.x, this._dead ? 0 : mv.y, aim, fire, detonate, ++this._seq);
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

    // Movement trails for the local player + every remote player with one equipped.
    if (this.phase === "playing") {
      if (!this._dead) this.#emitTrailFor(this.localTank, this._localTrail ?? this.profile.trail, dt);
      for (const p of this.players.values()) if (p.alive && p.tank.team.startsWith?.("player")) this.#emitTrailFor(p.tank, p.trail, dt);
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

  // Arena backdrop: the SAME floor + grid + border the offline game uses.
  #buildBackdrop(bounds) {
    const c = new Container();
    c.addChild(createArenaFloor(bounds), createGrid(bounds), createArenaBorder(bounds));
    return c;
  }

  // --- dev DOM (status HUD + Leave) -----------------------------------------
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
    document.body.append(this.overlay);
  }

  // Authoritative kill event: track my kills; on MY death show the real death screen
  // (with the killer card); spawn the death burst + kill FX + camera shake.
  #onKillMsg(m) {
    if (m.killer === this.myId) this._kills = (this._kills || 0) + 1;

    // Death burst + shake at the victim (any death), and my kill FX if I got it.
    const victim = m.victim === this.myId ? { x: this.localTank?.x ?? 0, y: this.localTank?.y ?? 0, color: this.localTank?.color ?? COLORS.tankBody } : this.players.get(m.victim);
    if (victim) {
      const vx = victim.x ?? victim.tank?.x, vy = victim.y ?? victim.tank?.y;
      const vcol = (typeof victim.color === "number") ? (GAME.cosmetics[victim.color]?.color ?? COLORS.tankBody) : (victim.color ?? COLORS.tankBody);
      if (vx != null) {
        this.#burst(vx, vy, vcol, 20);
        this.#shakeAt(vx, vy, 6);
        // Any player's kill spawns THEIR equipped kill FX (bots have none → no-op).
        this.#killEffect(vx, vy, vcol, m.killerInfo?.killFx);
      }
    }

    if (m.victim !== this.myId) return;
    this.#showDeath(m.killerInfo);
  }

  #onWinnerMsg(m) {
    if (m.id !== this.myId) return;
    const survival = (performance.now() - (this._spawnAt || performance.now())) / 1000;
    this.death.hide();
    this.winner.show({ name: this.profile.displayName, title: "CHAMPION", kills: this._kills || 0, survival, xp: this._lastReward?.xp ?? 0 }, { hidePlayAgain: true });
  }

  // Build the offline-shaped stats + killer object and show the REAL death screen.
  #showDeath(info) {
    const survival = (performance.now() - (this._spawnAt || performance.now())) / 1000;
    let killedBy = "the Toxic Fog", killer = null;
    if (info) {
      if (info.isGuardian) { killedBy = "a Guardian"; }
      else {
        killedBy = info.name || "a Tank";
        const c = GAME.cosmetics[info.color] || GAME.cosmetics[0];
        const t = GAME.titles[info.title];
        killer = {
          text: killedBy,
          tank: { color: c.color, gradient: gradOf(c), wrap: (GAME.wraps[info.wrap] || GAME.wraps[0]).pattern, turret: (GAME.weapons[info.weapon] || GAME.weapons[0]).turret || "single" },
          name: killedBy,
          title: t && !t.none && t.name ? { name: t.name, color: t.color, bold: t.bold } : null,
        };
      }
    }
    this.death.show({ killedBy, survival, kills: this._kills || 0, xp: this._lastReward?.xp ?? 0, killer }, { hidePlayAgain: true });
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
