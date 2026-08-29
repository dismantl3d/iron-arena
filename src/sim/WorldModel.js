// WorldModel — the AUTHORITATIVE, renderer-free game world. It owns the truth about
// combat entities (players + bots), their movement, Standard-turret firing,
// projectiles, collisions, damage, and death. No Pixi, no DOM, no camera, no UI —
// it runs identically in Node (the server) or a browser (a future client-side sim).
//
// Design goals for the multiplayer phases:
//   • Clients/AI push INTENT via setInput(); the model decides outcomes (no
//     client positions -> no teleporting; hit/damage/death are computed here).
//   • Entity records are plain data (the authoritative fields the network syncs),
//     deliberately separate from any render `view`.
//   • Per-entity stat fields (speed/cooldown/damage/bulletSpeed/bulletLife) default
//     to the Standard baseline but can be overridden — the hook for upgrade effects
//     and other weapons in later phases, WITHOUT changing this file's shape.
//
// Phase-1 scope: players + bots as movement/Standard-shooting entities. Fog/zone,
// guardians, loot/crates, upgrade resolution, and bot-AI execution are wired in in
// later phases (each entity already carries a `type`, `weapon`, and stat fields so
// those layers slot in without reshaping the model).

import { GAME, WORLD } from "../config.js";
import { SIM } from "./constants.js";
import { integrateMovement, muzzle, stepBullet, circleOverlap, clampAxis, num } from "./physics.js";
import { resolveEntityStats } from "./upgradeStats.js";
import { UpgradeState } from "./UpgradeState.js";
import { FogModel } from "./FogModel.js";
import { resolveShots, shotToProjectile, rocketProjectile, fireModeOf } from "./weapons.js";
import { ZONES, NORMAL_TYPES, SPECIALS, pickRarity } from "../game/upgrades.js";
import { botCanUse } from "../game/ai/context.js";
import { GuardianBrain } from "../game/GuardianBrain.js";
// NOTE: upgrades.js / ai/context.js / GuardianBrain.js are pure (config-only, no
// Pixi/DOM) — they import cleanly in Node, keeping this model renderer-free.

export class WorldModel {
  constructor(opts = {}) {
    this.arena = opts.arena ?? SIM.arena;
    this.bounds = { minX: -this.arena, minY: -this.arena, maxX: this.arena, maxY: this.arena };
    this.entities = new Map(); // id -> entity record (players + bots + guardians)
    this._list = []; // stable array mirror of entities (for cheap AI perception)
    this.bullets = []; // authoritative projectiles
    this.pickups = []; // authoritative world upgrade pickups
    this.crates = []; // authoritative loot crates (shot open → scatter pickups)
    this.walls = []; // static impassable rectangles (block movement + bullets)
    this.phase = "waiting"; // match state (waiting | playing)
    // Gate for hits/kills/contact/fog/loot. ON by default (existing callers/tests are
    // unchanged); the server turns it OFF for the peaceful waiting lobby (movement +
    // harmless preview firing still run, matching the single-player waiting room).
    this.damageEnabled = true;
    this.time = 0; // seconds since the model started stepping

    this._bulletSeq = 0;
    this._pickupSeq = 0;
    this._crateSeq = 0;
    this._gSeq = 0;
    this._wallSeq = 0;
    // Optional authoritative toxic-fog/zone (opt-in so callers that don't want it —
    // e.g. the Phase-1 server test match — behave exactly as before).
    this.fog = opts.fog ? new FogModel() : null;
    // Optional callback: ({ victim, killer }) when an entity is eliminated.
    this.onKill = opts.onKill ?? null;
    // How a fresh entity is placed; overridable so callers can use game spawn rules.
    this.spawnPoint = opts.spawnPoint ?? (() => this.#defaultSpawn());
  }

  // --- entities -------------------------------------------------------------
  // Add a combat entity. `type` is "player" | "bot". Returns the record.
  addEntity({ id, type = "player", team, name = "", color = 0, weapon = 0, x, y } = {}) {
    const sp = x == null || y == null ? this.spawnPoint() : { x, y };
    const e = {
      id,
      type,
      team: team ?? id, // own team by default (so everyone can damage everyone)
      name,
      color,
      weapon, // 0 = Standard (Phase 1)
      x: sp.x,
      y: sp.y,
      vx: 0,
      vy: 0,
      rot: 0,
      hp: SIM.maxHp,
      maxHp: SIM.maxHp,
      alive: true,
      input: { mx: 0, my: 0, aim: 0, fire: false },
      fireCd: 0,
      _contactCd: 0, // i-frames after taking contact damage (players)
      _regen: 0, // Healing-special regen accumulator
      upgrades: new UpgradeState(), // collected upgrades → resolveStats()
      // resolved stats (Standard baseline; upgrade/weapon layers may override these)
      speed: SIM.speed,
      accel: SIM.accel,
      cooldown: SIM.cooldown,
      damage: SIM.damage,
      bulletSpeed: SIM.bulletSpeed,
      bulletLife: SIM.bulletLife,
      bulletRadius: SIM.bulletRadius,
      armorMul: 1,
      armor: 0,
      _salvo: [], // staggered/burst shots queued for later this fire (Penta/Burst)
      heat: 0, // laser heat 0..1 (overheats at 1)
      overheat: 0, // laser lockout timer (s) while cooling from an overheat/interrupt
      _detPrev: false, // rocket SHIFT-detonate edge-detect
      // Fields the shared bot AI reads off a controllable entity (so a BotBrain can
      // drive a world-model entity headlessly, exactly as it drives a client Tank).
      // The AI never mutates these — it only reads them to decide intent.
      rotation: 0, // AI reads `.rotation`; kept in sync with `.rot` each step
      radius: SIM.radius,
      bounds: this.bounds,
      _hitTimer: 0, // "recently took damage" (AI reads it), decays each step
      dead: false, // mirror of !alive (the AI filters on `.dead`)
      _bulletSpeed: SIM.bulletSpeed, // AI-read aliases (leading/effective-range calc)
      _bulletLife: SIM.bulletLife,
    };
    this.entities.set(id, e);
    this._list.push(e);
    return e;
  }

  removeEntity(id) {
    const e = this.entities.get(id);
    if (e) {
      const i = this._list.indexOf(e);
      if (i >= 0) this._list.splice(i, 1);
    }
    return this.entities.delete(id);
  }

  get(id) {
    return this.entities.get(id);
  }

  // Store an entity's INTENT. Move axis is clamped to the unit disc (anti-teleport);
  // aim is a finite angle; fire is a boolean. Positions are never accepted here.
  setInput(id, { mx, my, aim, fire, detonate } = {}) {
    const e = this.entities.get(id);
    if (!e) return;
    const a = clampAxis(mx, my);
    e.input.mx = a.mx;
    e.input.my = a.my;
    e.input.aim = num(aim, e.input.aim);
    e.input.fire = !!fire;
    e.input.detonate = !!detonate; // Rocketeer SHIFT-detonate intent
  }

  // Resolve an entity's effective combat stats from its weapon + collected upgrades
  // (the SAME authoritative resolver the client uses). Call after collecting a
  // pickup so the model reflects upgrade effects. No new upgrade types.
  resolveStats(id) {
    const e = this.entities.get(id);
    if (!e) return;
    const w = GAME.weapons[e.weapon] || GAME.weapons[0];
    const s = resolveEntityStats(w, e.upgrades.normals);
    e.speed = s.speed;
    e.cooldown = s.fireRate;
    e.damage = s.bulletDamage;
    e.bulletSpeed = s.bulletSpeed;
    e.bulletLife = s.bulletLife;
    e.bulletRadius = s.bulletRadius;
    e.armorMul = s.armorMul;
    e._bulletSpeed = s.bulletSpeed; // AI-read aliases (leading / effective range)
    e._bulletLife = s.bulletLife;
    e.armor = s.armor;
    e._laser = s.laser; // resolved laser stats (tickDamage/tickRate) or null
  }

  // Respawn a dead entity at a fresh spawn with full HP.
  respawn(id) {
    const e = this.entities.get(id);
    if (!e) return;
    const sp = this.spawnPoint();
    e.x = sp.x; e.y = sp.y; e.vx = 0; e.vy = 0;
    e.hp = e.maxHp; e.alive = true; e.dead = false; e.fireCd = 0; e._hitTimer = 0;
    e._contactCd = 0;
  }

  // --- guardians (environmental patrols) -----------------------------------
  // An Arena Guardian: a heavy tank on GAME.guardian stats that PATROLS the center
  // and stops to fire. Driven by the SAME GuardianBrain the single-player game uses
  // — the model owns its movement/firing/damage/death (authoritative).
  addGuardian({ x = 0, y = 0 } = {}) {
    const g = GAME.guardian;
    const id = "guardian_" + String(++this._gSeq).padStart(2, "0");
    const e = this.addEntity({ id, type: "guardian", team: "guardian", name: "GUARDIAN", color: g.color, x, y });
    e.maxHp = g.hp; e.hp = g.hp;
    e.radius = g.radius;
    e.speed = g.speed;
    e.accel = SIM.accel;
    e.cooldown = g.fireRate;
    e.ai = new GuardianBrain(this.#guardianView());
    return e;
  }

  spawnGuardians() {
    const n = GAME.guardian.count;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 400;
      this.addGuardian({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
  }

  // Perception adapter GuardianBrain reads (it targets `player` + `bots`). On the
  // authoritative model there's no single "player": every human/bot combatant is a
  // candidate target (guardians never target other guardians).
  #guardianView() {
    if (!this._gView) {
      const w = this;
      this._gView = {
        player: null,
        get bots() { return w._list.filter((e) => e.alive && (e.type === "player" || e.type === "bot")); },
      };
    }
    return this._gView;
  }

  // --- match lifecycle (authoritative battle-royale world) -----------------
  // Build the full BR world: expand to the real arena, drop combatants (humans in
  // the outer ring, bots scattered), spawn guardians + walls + loot, reset the fog.
  // Called by the server when the waiting-room countdown ends. Idempotent per round.
  beginMatch() {
    this.arena = WORLD.arenaHalf;
    this.bounds = WORLD.bounds;
    for (const e of this._list) {
      if (e.type === "guardian") continue;
      e.bounds = this.bounds;
      if (e.type === "player") {
        const a = Math.random() * Math.PI * 2, r = WORLD.arenaHalf * 0.82;
        e.x = Math.cos(a) * r; e.y = Math.sin(a) * r;
      } else {
        this.#placeScatter(e);
      }
      e.vx = 0; e.vy = 0;
    }
    this.#generateWalls();
    this.spawnGuardians();
    this.#generateLoot();
    if (this.fog) this.fog.reset();
    this.phase = "playing";
  }

  // Reset to a fresh waiting lobby (small arena, no loot/guardians/walls): used
  // between rounds so a new match can start from the waiting room.
  resetToWaiting() {
    for (const e of [...this._list]) if (e.type === "guardian") this.removeEntity(e.id);
    this.pickups = []; this.crates = []; this.walls = []; this.bullets = [];
    this.arena = SIM.arena;
    this.bounds = { minX: -this.arena, minY: -this.arena, maxX: this.arena, maxY: this.arena };
    for (const e of this._list) {
      e.bounds = this.bounds;
      e.upgrades = new UpgradeState();
      this.resolveStats(e.id);
      const sp = this.spawnPoint();
      e.x = sp.x; e.y = sp.y; e.vx = 0; e.vy = 0;
      e.hp = e.maxHp; e.alive = true; e.dead = false;
    }
    if (this.fog) this.fog.reset();
    this.phase = "waiting";
  }

  #placeScatter(e) {
    const b = this.bounds, m = 240;
    let x = 0, y = 0, tries = 0;
    do {
      x = b.minX + m + Math.random() * (b.maxX - b.minX - 2 * m);
      y = b.minY + m + Math.random() * (b.maxY - b.minY - 2 * m);
    } while (x * x + y * y < 950 * 950 && tries++ < 25); // keep clear of the guardian nest
    e.x = x; e.y = y;
  }

  #randInRing(r0, r1) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(r0 * r0 + Math.random() * (r1 * r1 - r0 * r0)); // uniform by area
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  }

  // Procedural wall clusters (ported from Game.#spawnWalls; the model is authority).
  #generateWalls() {
    this.walls = [];
    const cfg = GAME.walls;
    const [pmin, pmax] = cfg.perCluster, [smin, smax] = cfg.size;
    const reach = WORLD.arenaHalf * 0.92;
    let made = 0, guard = 0;
    while (made < cfg.clusters && guard++ < cfg.clusters * 12) {
      const a = Math.random() * Math.PI * 2;
      const r = cfg.avoidCenter + Math.random() * (reach - cfg.avoidCenter);
      const cx = Math.cos(a) * r, cy = Math.sin(a) * r;
      const n = pmin + ((Math.random() * (pmax - pmin + 1)) | 0);
      for (let i = 0; i < n; i++) {
        const w = smin + Math.random() * (smax - smin);
        const h = smin + Math.random() * (smax - smin);
        const x = cx + (Math.random() - 0.5) * smax * 1.4;
        const y = cy + (Math.random() - 0.5) * smax * 1.4;
        this.walls.push({ id: ++this._wallSeq, x, y, w, h, minX: x - w / 2, minY: y - h / 2, maxX: x + w / 2, maxY: y + h / 2 });
      }
      made++;
    }
  }

  // Upgrade pickups + loot crates across the concentric rarity zones (ported from
  // Game.#spawnPickups / #spawnCrates). The model owns them authoritatively.
  #generateLoot() {
    this.pickups = []; this.crates = [];
    let inner = 0;
    for (const zone of ZONES) {
      for (let i = 0; i < zone.pickups; i++) {
        const { x, y } = this.#randInRing(inner, zone.maxR);
        this.#addPickup({ x, y, kind: "normal", typeKey: NORMAL_TYPES[(Math.random() * NORMAL_TYPES.length) | 0].key, rarity: pickRarity(zone.weights) });
      }
      for (let i = 0; i < zone.specials; i++) {
        const { x, y } = this.#randInRing(inner, zone.maxR);
        this.#addPickup({ x, y, kind: "special", typeKey: SPECIALS[(Math.random() * SPECIALS.length) | 0].key });
      }
      inner = zone.maxR;
    }
    inner = 0;
    ZONES.forEach((zone, zi) => {
      const n = GAME.crate.perZone[zi] || 0;
      for (let i = 0; i < n; i++) {
        const { x, y } = this.#randInRing(inner, zone.maxR);
        const items = [];
        for (let k = 0; k < GAME.crate.items; k++) {
          if (Math.random() < GAME.crate.specialChance) items.push({ kind: "special", typeKey: SPECIALS[(Math.random() * SPECIALS.length) | 0].key });
          else items.push({ kind: "normal", typeKey: NORMAL_TYPES[(Math.random() * NORMAL_TYPES.length) | 0].key, rarity: pickRarity(zone.weights) });
        }
        this.#addCrate({ x, y, rarity: pickRarity(zone.weights), items });
      }
      inner = zone.maxR;
    });
  }

  #addPickup({ x, y, kind, typeKey, rarity = 0, vx = 0, vy = 0, pickupDelay = 0 }) {
    this.pickups.push({ id: ++this._pickupSeq, kind, typeKey, rarity, x, y, vx, vy, delay: pickupDelay, collectable: pickupDelay <= 0, dead: false });
  }

  #addCrate({ x, y, rarity, items }) {
    const r = GAME.crate.radius;
    this.crates.push({ id: ++this._crateSeq, x, y, rarity, items, hp: GAME.crate.hp, radius: r, minX: x - r, minY: y - r, maxX: x + r, maxY: y + r, dead: false });
  }

  // A game-like perception adapter so the shared BotBrain/ai modules can read this
  // world (enemies/bullets/fog) exactly as they read the client `Game`. The AI only
  // READS this — it feeds intent back via setInput(). No BotBrain dependency here,
  // so the model stays AI-agnostic (and renderer-free).
  aiView() {
    const w = this;
    if (!this._aiView) {
      this._aiView = {
        phase: "playing",
        player: null, // set to a player entity when a human is present
        // Combatants the bot AI treats as enemies/allies = players + bots (NOT the
        // environmental guardians, which the AI reads from `guardians` separately).
        get bots() { return w._list.filter((e) => e.type === "player" || e.type === "bot"); },
        get guardians() { return w._list.filter((e) => e.type === "guardian"); },
        get pickups() { return w.pickups; },
        get crates() { return w.crates; },
        get bullets() { return w.bullets; }, // reassigned on filter → live getter
        get fog() { return w.fog; },
      };
    }
    return this._aiView;
  }

  // --- authoritative simulation --------------------------------------------
  step(dt) {
    this.time += dt;

    // 0) Guardian DECISIONS → intent (the model owns their outcomes). Guardians are
    //    environmental, so — unlike bots (server-driven) — the model drives them.
    for (const e of this._list) {
      if (e.type !== "guardian" || !e.alive) continue;
      const cmd = e.ai.think(dt, e);
      const mv = cmd.move || { x: 0, y: 0 };
      e.input.mx = mv.x; e.input.my = mv.y;
      e.input.aim = num(cmd.aim, e.input.aim);
      e.input.fire = !!e.ai.hasTarget; // fire only when a target is in range
    }

    // 1) Movement (from intent) + weapon firing (data-driven; guardian branch too).
    for (const e of this.entities.values()) {
      if (!e.alive) continue;
      e.rot = e.input.aim;
      e.rotation = e.rot; // mirror for the AI (which reads `.rotation`)
      if (e._hitTimer > 0) e._hitTimer -= dt; // "recently in combat" decays
      if (e._contactCd > 0) e._contactCd -= dt;
      integrateMovement(e, dt, e.input.mx, e.input.my, e.speed, e.accel, this.bounds, e.radius);
      // Healing special: regenerate HP over time (matches Game.#specialsPassive).
      if (e.type === "player" && e.upgrades.hasSpecial("healing")) e.hp = Math.min(e.maxHp, e.hp + 6 * dt);
      this.#weaponUpdate(e, dt); // data-driven firing (any weapon in GAME.weapons)
    }

    // 2) Projectiles + authoritative collision → damage → death (+ crates/walls).
    this.#stepBullets(dt);

    // 3) World interactions: walls push tanks out; contact damage; loot pickup +
    //    crate/pickup motion. Only meaningful once the BR world is populated.
    if (this.walls.length) this.#resolveWalls();
    if (this.damageEnabled) this.#contactDamage(dt);
    if (this.damageEnabled && (this.pickups.length || this.crates.length)) this.#updateLoot(dt);

    // 4) Toxic fog/zone (only when enabled) — shrink the zone + damage anyone
    //    outside it, and consume loot left outside the safe zone.
    if (this.fog && this.damageEnabled) this.#stepFog(dt);
  }

  #stepFog(dt) {
    this.fog.update(dt, this.#fogIntensity());
    const dps = GAME.fog.dps * dt;
    for (const e of this.entities.values()) {
      if (!e.alive || e.type === "guardian") continue; // guardians ignore the fog
      if (!this.fog.isOutside(e.x, e.y)) continue;
      e.hp = Math.max(0, e.hp - dps);
      if (e.hp <= 0) {
        e.alive = false;
        e.dead = true;
        this.onKill?.({ victim: e.id, killer: null }); // fog kill (no killer)
      }
    }
    // Loot left outside the shrinking safe zone is lost to the fog.
    for (const c of this.crates) if (!c.dead && this.fog.isOutside(c.x, c.y)) c.dead = true;
    for (const p of this.pickups) if (!p.dead && this.fog.isOutside(p.x, p.y)) p.dead = true;
    if (this.crates.some((c) => c.dead)) this.crates = this.crates.filter((c) => !c.dead);
    if (this.pickups.some((p) => p.dead)) this.pickups = this.pickups.filter((p) => !p.dead);
  }

  // Fog shrink multiplier: accelerates as the roster thins (matches Game.#fogIntensity).
  #fogIntensity() {
    let alive = 0;
    for (const e of this._list) if (e.alive && (e.type === "player" || e.type === "bot")) alive++;
    if (alive <= GAME.endgame.finalAt) return GAME.endgame.finalMul;
    if (alive <= GAME.endgame.compressAt) return GAME.endgame.compressMul;
    return 1;
  }

  // Count of combatants still alive (players + bots; guardians are environmental).
  aliveCombatants() {
    let n = 0;
    for (const e of this._list) if (e.alive && (e.type === "player" || e.type === "bot")) n++;
    return n;
  }

  // Per-entity weapon update: cooldown, staggered/burst salvo, fire trigger, and
  // the continuous mechanics (rocket trails/detonation, laser beam + heat). All of
  // it is dispatched from GAME.weapons config via src/sim/weapons.js — no per-weapon
  // code here, so a new config-defined weapon works automatically.
  #weaponUpdate(e, dt) {
    if (e.type === "guardian") { this.#guardianFire(e, dt); return; }
    const w = GAME.weapons[e.weapon] || GAME.weapons[0];
    const mode = fireModeOf(w);
    if (e.fireCd > 0) e.fireCd -= dt;

    // Fire any staggered/burst shots whose delay elapsed.
    if (e._salvo.length) {
      const stats = this.#statsOf(e);
      const origin = this.#originOf(e);
      for (const q of e._salvo) { q.t -= dt; if (q.t <= 0) this.#spawnProjectile(shotToProjectile(q.shot, w, stats, origin), e); }
      e._salvo = e._salvo.filter((q) => q.t > 0);
    }

    if (mode === "laser") { this.#laserUpdate(e, w, dt); return; }
    if (mode === "rocket") this.#rocketUpdate(e, w, dt); // trails + SHIFT detonate

    // Trigger.
    if (e.input.fire && e.fireCd <= 0) {
      e.fireCd = e.cooldown || w.cooldown;
      if (mode === "rocket") {
        this.#spawnProjectile(rocketProjectile(w, this.#originOf(e)), e, { trail: w.rocket.trail?.interval ?? 0.1, rocketCfg: w.rocket });
      } else {
        const { immediate, salvo } = resolveShots(w, this.#statsOf(e), this.#originOf(e));
        for (const pr of immediate) this.#spawnProjectile(pr, e);
        for (const q of salvo) e._salvo.push(q);
      }
    }
  }

  #statsOf(e) {
    return { bulletSpeed: e.bulletSpeed, bulletRadius: e.bulletRadius, bulletLife: e.bulletLife, bulletDamage: e.damage, armorMul: e.armorMul };
  }
  #originOf(e) {
    return { x: e.x, y: e.y, rot: e.rot, radius: e.radius };
  }

  // Turn a projectile descriptor into an authoritative bullet.
  #spawnProjectile(pr, owner, extra = {}) {
    this.bullets.push({
      id: ++this._bulletSeq,
      owner: owner.id,
      team: owner.team,
      x: pr.x, y: pr.y,
      vx: pr.vx, vy: pr.vy,
      life: pr.life,
      damage: pr.damage,
      radius: pr.radius ?? SIM.bulletRadius,
      armorMul: pr.armorMul ?? 1,
      pierce: pr.pierce || 0,
      shape: pr.shape || "circle",
      isRocket: pr.isRocket || false,
      trail: extra.trail || 0, // rocket rear-trail interval (0 = none)
      trailT: extra.trail || 0,
      rocketCfg: extra.rocketCfg || null,
    });
  }

  // Rocketeer: rear-fired trail bullets from each live rocket + SHIFT detonation of
  // all of this entity's rockets into pellet rings (config-driven).
  #rocketUpdate(e, w, dt) {
    const detonate = e.input.detonate && !e._detPrev; // rising edge
    e._detPrev = !!e.input.detonate;
    for (const b of this.bullets) {
      if (!b.isRocket || b.owner !== e.id || b.dead) continue;
      // rear trail
      if (b.trail > 0) {
        b.trailT -= dt;
        if (b.trailT <= 0) {
          b.trailT = b.trail;
          const tr = b.rocketCfg?.trail;
          if (tr) {
            const back = Math.atan2(b.vy, b.vx) + Math.PI;
            this.bullets.push({ id: ++this._bulletSeq, owner: e.id, team: e.team, x: b.x, y: b.y, vx: Math.cos(back) * tr.speed, vy: Math.sin(back) * tr.speed, life: 0.7, damage: tr.damage, radius: tr.size, armorMul: 1, pierce: 0, shape: "circle", isRocket: false });
          }
        }
      }
      if (detonate) this.#detonateRocket(b, e);
    }
  }

  #detonateRocket(rocket, e) {
    rocket.dead = true;
    const det = rocket.rocketCfg?.detonate;
    if (!det) return;
    for (const ring of det.layers || []) {
      for (let i = 0; i < ring.count; i++) {
        const a = (i / ring.count) * Math.PI * 2;
        this.bullets.push({ id: ++this._bulletSeq, owner: e.id, team: e.team, x: rocket.x, y: rocket.y, vx: Math.cos(a) * ring.speed, vy: Math.sin(a) * ring.speed, life: 0.5, damage: ring.damage, radius: ring.size, armorMul: 1, pierce: 0, shape: "star", isRocket: false });
      }
    }
  }

  // Guardian firing: a single slow heavy shell on the guardian's own cooldown,
  // using GAME.guardian stats (not a player weapon). Gated by ai.hasTarget upstream.
  #guardianFire(e, dt) {
    if (e.fireCd > 0) e.fireCd -= dt;
    if (!e.input.fire || e.fireCd > 0) return;
    const g = GAME.guardian;
    e.fireCd = g.fireRate;
    const m = muzzle(e.x, e.y, e.rot, e.radius * 2.2);
    this.bullets.push({
      id: ++this._bulletSeq, owner: e.id, team: "guardian",
      x: m.x, y: m.y, vx: Math.cos(e.rot) * g.bulletSpeed, vy: Math.sin(e.rot) * g.bulletSpeed,
      life: g.bulletLife, damage: g.bulletDamage, radius: SIM.bulletRadius * 1.4,
      armorMul: 1, pierce: 0, shape: "circle", guardian: true,
    });
  }

  // Push tanks out of walls (circle-vs-AABB, shortest axis). Bullets that hit a
  // wall are killed in #stepBullets. Ported from Game.#resolveWalls.
  #resolveWalls() {
    for (const w of this.walls) {
      for (const t of this.entities.values()) {
        if (!t.alive) continue;
        const nx = Math.max(w.minX, Math.min(t.x, w.maxX));
        const ny = Math.max(w.minY, Math.min(t.y, w.maxY));
        const dx = t.x - nx, dy = t.y - ny;
        if (dx * dx + dy * dy < t.radius * t.radius) {
          if (dx === 0 && dy === 0) continue;
          const d = Math.hypot(dx, dy);
          const push = t.radius - d;
          t.x += (dx / d) * push; t.y += (dy / d) * push;
          if (Math.abs(dx) > Math.abs(dy)) t.vx = 0; else t.vy = 0;
        }
      }
    }
  }

  // Contact damage: a human player ramming (or being rammed by) a bot/guardian
  // takes damage on i-frames. Matches Game.#contactDamage (only players are hurt on
  // contact; bots/guardians trade via bullets). Multi-human safe (per-entity cd).
  #contactDamage(dt) {
    for (const p of this.entities.values()) {
      if (!p.alive || p.type !== "player" || p._contactCd > 0) continue;
      for (const t of this.entities.values()) {
        if (!t.alive || t === p || (t.type !== "bot" && t.type !== "guardian")) continue;
        if (!circleOverlap(p.x, p.y, p.radius, t.x, t.y, t.radius)) continue;
        const dmg = t.type === "guardian" ? GAME.guardian.contactDamage : GAME.bot.contactDamage;
        p.hp = Math.max(0, p.hp - dmg);
        p._contactCd = GAME.player.contactInvuln;
        p._hitTimer = 1.5;
        if (p.hp <= 0 && p.alive) { p.alive = false; p.dead = true; this.onKill?.({ victim: p.id, killer: t.type === "guardian" ? t.id : t.id }); }
        break;
      }
    }
  }

  // Loot: age scattered pickups (glide + settle + collectability delay), then let
  // any alive combatant collect a pickup it physically overlaps — through the SAME
  // authoritative rules the single-player game uses (Game.#collectPickups/#botPickups).
  #updateLoot(dt) {
    for (const pk of this.pickups) {
      if (pk.dead) continue;
      if (pk.vx || pk.vy) { pk.x += pk.vx * dt; pk.y += pk.vy * dt; pk.vx *= 0.86; pk.vy *= 0.86; if (Math.hypot(pk.vx, pk.vy) < 8) { pk.vx = pk.vy = 0; } }
      if (!pk.collectable) { pk.delay -= dt; if (pk.delay <= 0) pk.collectable = true; }
    }
    for (const e of this.entities.values()) {
      if (!e.alive || e.type === "guardian") continue;
      const isPlayer = e.type === "player";
      const bonus = isPlayer && e.upgrades.hasSpecial("loot") ? 90 : 0; // Loot Drone range
      for (const pk of this.pickups) {
        if (pk.dead || !pk.collectable) continue;
        const reach = e.radius + 20 + bonus;
        const dx = pk.x - e.x, dy = pk.y - e.y;
        if (dx * dx + dy * dy > reach * reach) continue;
        if (pk.kind === "special") {
          if (!isPlayer) continue; // bots don't use specials (botCanUse)
          if (e.upgrades.hasSpecial(pk.typeKey)) continue; // own it → ghost
          pk.dead = true;
          e.upgrades.collectSpecial(pk.typeKey);
        } else {
          if (!isPlayer && !botCanUse(pk, e)) continue;
          const cur = e.upgrades.normals[pk.typeKey];
          if (cur !== undefined && cur >= pk.rarity) continue; // own equal/better → ghost
          pk.dead = true;
          e.upgrades.collectNormal(pk.typeKey, pk.rarity);
          this.resolveStats(e.id); // upgrades change real stats
        }
      }
    }
    if (this.pickups.some((p) => p.dead)) this.pickups = this.pickups.filter((p) => !p.dead);
  }

  // Laser Rifle: a finite-range beam with a heat/overheat system. While firing (and
  // not overheated) it raycasts to the nearest enemy in range and applies DoT; heat
  // builds to an overheat lockout, and cools when released. `e.beam` (endpoint) +
  // `e.heat` are exposed for rendering.
  #laserUpdate(e, w, dt) {
    const L = w.laser;
    const firing = e.input.fire && e.overheat <= 0;
    if (e.overheat > 0) e.overheat = Math.max(0, e.overheat - dt);

    if (firing) {
      e.heat = Math.min(1, e.heat + dt / L.heatTime);
      if (e.heat >= 1) { e.overheat = L.coolTime; e.beam = null; return; }
      // Raycast along aim to the nearest enemy within range.
      const dirx = Math.cos(e.rot), diry = Math.sin(e.rot);
      const m = muzzle(e.x, e.y, e.rot, w.muzzle ?? e.radius * 2.2);
      let hitT = L.range, hit = null;
      for (const t of this.entities.values()) {
        if (!t.alive || t.team === e.team) continue;
        const rx = t.x - m.x, ry = t.y - m.y;
        const proj = rx * dirx + ry * diry;
        if (proj <= 0 || proj > L.range) continue;
        const perp = Math.abs(rx * diry - ry * dirx);
        if (perp <= t.radius + 4 && proj < hitT) { hitT = proj; hit = t; }
      }
      e.beam = { x: m.x + dirx * hitT, y: m.y + diry * hitT };
      // Damage over time at the configured tick rate.
      e._laserTick = (e._laserTick || 0) - dt;
      if (hit && this.damageEnabled && e._laserTick <= 0) {
        e._laserTick = (e._laser?.tickRate ?? L.tickRate);
        const dmg = (e._laser?.tickDamage ?? L.tickDamage);
        hit.hp = Math.max(0, hit.hp - dmg * (1 - Math.min(0.9, hit.armor || 0)));
        hit._hitTimer = 1.5;
        if (hit.hp <= 0 && hit.alive) { hit.alive = false; hit.dead = true; this.onKill?.({ victim: hit.id, killer: e.id }); }
      }
    } else {
      e.heat = Math.max(0, e.heat - dt / L.coolTime);
      e.beam = null;
    }
  }

  #stepBullets(dt) {
    const arena = this.arena;
    for (const b of this.bullets) {
      stepBullet(b, dt);
      if (b.life <= 0 || Math.abs(b.x) > arena || Math.abs(b.y) > arena) {
        b.dead = true;
        continue;
      }
      if (this.damageEnabled) for (const e of this.entities.values()) {
        if (!e.alive || e.team === b.team) continue; // friendly fire off within a team
        if (b.hitSet && b.hitSet.has(e.id)) continue; // piercing round: don't re-hit
        if (circleOverlap(e.x, e.y, e.radius, b.x, b.y, b.radius ?? SIM.bulletRadius)) {
          const armor = Math.min(0.9, (e.armor || 0) * (b.armorMul ?? 1)); // Sniper/etc pierce armor
          e.hp = Math.max(0, e.hp - b.damage * (1 - armor));
          e._hitTimer = 1.5; // "recently took damage" (read by the AI)
          if (e.hp <= 0 && e.alive) {
            e.alive = false;
            e.dead = true;
            this.onKill?.({ victim: e.id, killer: b.owner });
          }
          if (b.pierce > 0) { b.pierce--; (b.hitSet ||= new Set()).add(e.id); } // pass through
          else b.dead = true;
          break;
        }
      }
      if (b.dead) continue;
      // Crates are SHOT open by player/bot bullets (not guardian shells).
      if (this.damageEnabled && this.crates.length && !b.guardian) {
        for (const c of this.crates) {
          if (c.dead) continue;
          const nx = Math.max(c.minX, Math.min(b.x, c.maxX));
          const ny = Math.max(c.minY, Math.min(b.y, c.maxY));
          const dx = b.x - nx, dy = b.y - ny;
          if (dx * dx + dy * dy <= (b.radius ?? SIM.bulletRadius) ** 2) {
            b.dead = true;
            c.hp -= b.damage;
            if (c.hp <= 0) this.#breakCrate(c);
            break;
          }
        }
        if (b.dead) continue;
      }
      // Walls stop bullets.
      for (const w of this.walls) {
        if (b.x >= w.minX && b.x <= w.maxX && b.y >= w.minY && b.y <= w.maxY) { b.dead = true; break; }
      }
    }
    if (this.bullets.some((b) => b.dead)) this.bullets = this.bullets.filter((b) => !b.dead);
    if (this.crates.some((c) => c.dead)) this.crates = this.crates.filter((c) => !c.dead);
  }

  // A shot-open crate scatters its items outward as collectible pickups (nothing is
  // auto-granted — combatants walk over them). Matches Game.#breakCrate/#scatterItem.
  #breakCrate(c) {
    c.dead = true;
    for (const it of c.items) {
      const a = Math.random() * Math.PI * 2;
      const spd = 170 + Math.random() * 150;
      this.#addPickup({ x: c.x, y: c.y, kind: it.kind, typeKey: it.typeKey, rarity: it.rarity || 0, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, pickupDelay: 0.5 });
    }
  }

  // --- networking -----------------------------------------------------------
  // A compact authoritative snapshot for broadcasting to clients.
  snapshot() {
    const snap = {
      phase: this.phase,
      alive: this.aliveCombatants(),
      players: [...this.entities.values()].map((e) => {
        const p = {
          id: e.id, type: e.type, name: e.name, color: e.color, weapon: e.weapon,
          x: round(e.x, 100), y: round(e.y, 100), rot: round(e.rot, 1000),
          hp: Math.round(e.hp), maxHp: e.maxHp, alive: e.alive,
        };
        if (e.type === "guardian") p.r = e.radius; // clients size the guardian tank
        if (e.heat > 0.01) p.heat = round(e.heat, 100); // laser barrel glow
        if (e.beam) p.beam = { x: round(e.beam.x, 10), y: round(e.beam.y, 10) }; // laser endpoint
        // Owned upgrades (for the owner's HUD + Loot/Radar range) — only when any.
        const nk = Object.keys(e.upgrades.normals);
        if (nk.length || e.upgrades.specials.length) p.up = { n: e.upgrades.normals, s: e.upgrades.specials };
        return p;
      }),
      // Only non-default projectile shape/radius are sent, keeping snapshots small.
      bullets: this.bullets.map((b) => {
        const o = { id: b.id, owner: b.owner, x: round(b.x, 10), y: round(b.y, 10), vx: b.vx, vy: b.vy };
        if (b.shape && b.shape !== "circle") o.shape = b.shape;
        if (b.radius && b.radius !== SIM.bulletRadius) o.radius = round(b.radius, 10);
        if (b.guardian) o.g = 1; // guardian shell → drawn dark red
        return o;
      }),
      crates: this.crates.map((c) => ({ id: c.id, x: round(c.x, 10), y: round(c.y, 10) })),
      pickups: this.pickups.map((p) => ({ id: p.id, x: round(p.x, 10), y: round(p.y, 10), k: p.kind, t: p.typeKey, r: p.rarity })),
    };
    if (this.fog) snap.fog = { r: round(this.fog.radius, 10), nr: this.fog.nextRadius == null ? null : round(this.fog.nextRadius, 10), st: this.fog.state, ti: round(this.fog.timer, 10) };
    return snap;
  }

  // Static world geometry (walls) — sent once in `welcome` (they never move).
  wallData() {
    return this.walls.map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h }));
  }

  #defaultSpawn() {
    const a = Math.random() * Math.PI * 2;
    const r = 90 + Math.random() * 160; // tight cluster near center (Phase-1 test)
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  }
}

const round = (v, f) => Math.round(v * f) / f;
