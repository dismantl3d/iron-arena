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

import { GAME } from "../config.js";
import { SIM } from "./constants.js";
import { integrateMovement, muzzle, stepBullet, circleOverlap, clampAxis, num } from "./physics.js";
import { resolveEntityStats } from "./upgradeStats.js";
import { UpgradeState } from "./UpgradeState.js";
import { FogModel } from "./FogModel.js";

export class WorldModel {
  constructor(opts = {}) {
    this.arena = opts.arena ?? SIM.arena;
    this.bounds = { minX: -this.arena, minY: -this.arena, maxX: this.arena, maxY: this.arena };
    this.entities = new Map(); // id -> entity record (players + bots)
    this._list = []; // stable array mirror of entities (for cheap AI perception)
    this.bullets = []; // authoritative projectiles
    this.phase = "waiting"; // match state (waiting | playing) — structure for later
    this.time = 0; // seconds since the model started stepping

    this._bulletSeq = 0;
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
      upgrades: new UpgradeState(), // collected upgrades → resolveStats()
      // resolved stats (Standard baseline; upgrade/weapon layers may override these)
      speed: SIM.speed,
      accel: SIM.accel,
      cooldown: SIM.cooldown,
      damage: SIM.damage,
      bulletSpeed: SIM.bulletSpeed,
      bulletLife: SIM.bulletLife,
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
  setInput(id, { mx, my, aim, fire } = {}) {
    const e = this.entities.get(id);
    if (!e) return;
    const a = clampAxis(mx, my);
    e.input.mx = a.mx;
    e.input.my = a.my;
    e.input.aim = num(aim, e.input.aim);
    e.input.fire = !!fire;
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
    e._bulletSpeed = s.bulletSpeed; // AI-read aliases (leading / effective range)
    e._bulletLife = s.bulletLife;
    e.armor = s.armor;
  }

  // Respawn a dead entity at a fresh spawn with full HP.
  respawn(id) {
    const e = this.entities.get(id);
    if (!e) return;
    const sp = this.spawnPoint();
    e.x = sp.x; e.y = sp.y; e.vx = 0; e.vy = 0;
    e.hp = e.maxHp; e.alive = true; e.dead = false; e.fireCd = 0; e._hitTimer = 0;
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
        bots: w._list, // stable array, mutated in place on add/remove
        guardians: [],
        pickups: [],
        crates: [],
        get bullets() { return w.bullets; }, // reassigned on filter → live getter
        get fog() { return w.fog; },
      };
    }
    return this._aiView;
  }

  // --- authoritative simulation --------------------------------------------
  step(dt) {
    this.time += dt;

    // 1) Movement (from intent) + Standard-turret firing (cooldown-gated).
    for (const e of this.entities.values()) {
      if (!e.alive) continue;
      e.rot = e.input.aim;
      e.rotation = e.rot; // mirror for the AI (which reads `.rotation`)
      if (e._hitTimer > 0) e._hitTimer -= dt; // "recently in combat" decays
      integrateMovement(e, dt, e.input.mx, e.input.my, e.speed, e.accel, this.bounds, SIM.radius);
      if (e.fireCd > 0) e.fireCd -= dt;
      if (e.input.fire && e.fireCd <= 0) {
        e.fireCd = e.cooldown;
        this.#fire(e);
      }
    }

    // 2) Projectiles + authoritative collision → damage → death.
    this.#stepBullets(dt);

    // 3) Toxic fog/zone (only when enabled) — shrink the zone + damage anyone
    //    outside it. Off by default so the Phase-1 server behaves unchanged.
    if (this.fog) this.#stepFog(dt);
  }

  #stepFog(dt) {
    this.fog.update(dt);
    const dps = GAME.fog.dps * dt;
    for (const e of this.entities.values()) {
      if (!e.alive || !this.fog.isOutside(e.x, e.y)) continue;
      e.hp = Math.max(0, e.hp - dps);
      if (e.hp <= 0) {
        e.alive = false;
        e.dead = true;
        this.onKill?.({ victim: e.id, killer: null }); // fog kill (no killer)
      }
    }
  }

  #fire(e) {
    const m = muzzle(e.x, e.y, e.rot, SIM.barrel);
    this.bullets.push({
      id: ++this._bulletSeq,
      owner: e.id,
      team: e.team,
      x: m.x,
      y: m.y,
      vx: Math.cos(e.rot) * e.bulletSpeed,
      vy: Math.sin(e.rot) * e.bulletSpeed,
      life: e.bulletLife,
      damage: e.damage,
    });
  }

  #stepBullets(dt) {
    const arena = this.arena;
    for (const b of this.bullets) {
      stepBullet(b, dt);
      if (b.life <= 0 || Math.abs(b.x) > arena || Math.abs(b.y) > arena) {
        b.dead = true;
        continue;
      }
      for (const e of this.entities.values()) {
        if (!e.alive || e.team === b.team) continue; // friendly fire off within a team
        if (circleOverlap(e.x, e.y, SIM.radius, b.x, b.y, SIM.bulletRadius)) {
          e.hp = Math.max(0, e.hp - b.damage);
          e._hitTimer = 1.5; // "recently took damage" (read by the AI)
          b.dead = true;
          if (e.hp <= 0) {
            e.alive = false;
            e.dead = true;
            this.onKill?.({ victim: e.id, killer: b.owner });
          }
          break;
        }
      }
    }
    if (this.bullets.some((b) => b.dead)) this.bullets = this.bullets.filter((b) => !b.dead);
  }

  // --- networking -----------------------------------------------------------
  // A compact authoritative snapshot for broadcasting to clients.
  snapshot() {
    return {
      players: [...this.entities.values()].map((e) => ({
        id: e.id, type: e.type, name: e.name, color: e.color, weapon: e.weapon,
        x: round(e.x, 100), y: round(e.y, 100), rot: round(e.rot, 1000),
        hp: Math.round(e.hp), maxHp: e.maxHp, alive: e.alive,
      })),
      bullets: this.bullets.map((b) => ({ id: b.id, owner: b.owner, x: round(b.x, 10), y: round(b.y, 10), vx: b.vx, vy: b.vy })),
    };
  }

  #defaultSpawn() {
    const a = Math.random() * Math.PI * 2;
    const r = 90 + Math.random() * 160; // tight cluster near center (Phase-1 test)
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  }
}

const round = (v, f) => Math.round(v * f) / f;
