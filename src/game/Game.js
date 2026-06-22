// Game is the gameplay coordinator (NOT in the engine). It runs the match
// lifecycle and the battle-royale systems:
//
//   phases: menu -> waiting -> playing -> (dead | won)
//
//   - Battle royale: population fixed at match start (player + bots up to
//     matchSize), NO respawns, deaths permanent, last tank standing wins.
//   - Upgrades are collected as world pickups (rarity zones), not bought; a
//     higher rarity of a type replaces the lower one (no stacking).
//   - Special upgrades (max 2) grant light abilities (healing/flash/drones/radar).
//   - Toxic fog shrinks inward, damaging anyone outside the safe zone.
//   - Arena Guardians hold the center to deter early rushing.
//
// Bots/player/guardians are all the same Tank entity, distinguished by `team`.
// Combat is team-based: a bullet damages any tank on a different team. All of
// this is gated by `combatEnabled` so the waiting room stays peaceful.

import { Text } from "pixi.js";
import { Tank } from "../entities/Tank.js";
import { Bullet } from "../entities/Bullet.js";
import { Particle } from "../entities/Particle.js";
import { DamageNumber } from "../entities/DamageNumber.js";
import { UpgradePickup } from "../entities/UpgradePickup.js";
import { Drone } from "../entities/Drone.js";
import { BotBrain } from "./BotBrain.js";
import { GuardianBrain } from "./GuardianBrain.js";
import { Fog } from "./Fog.js";
import { UpgradeState } from "./UpgradeState.js";
import {
  ZONES,
  NORMAL_TYPES,
  SPECIALS,
  RARITY_COLOR,
  pickRarity,
  deriveUpgradeStats,
} from "./upgrades.js";
import { Hud } from "../ui/Hud.js";
import { UpgradeHud } from "../ui/UpgradeHud.js";
import { createGrid } from "../render/Grid.js";
import { createArenaFloor, createArenaBorder } from "../render/Arena.js";
import { COLORS, WORLD, GAME } from "../config.js";

export class Game {
  // callbacks: { onCountdown(s), onMatchStart(), onMatchEnd(stats), onWin(stats) }
  constructor(engine, input, callbacks = {}) {
    this.engine = engine;
    this.input = input;
    this.callbacks = callbacks;

    this.bounds = WORLD.bounds;
    this.score = 0;
    this.kills = 0;
    this.bullets = [];
    this.bots = [];
    this.guardians = [];
    this.pickups = [];
    this.player = null;
    this.profile = null;
    this.weapon = GAME.weapons[0];
    this.upgrades = new UpgradeState();
    this.sentryDrone = null;
    this.lootDrone = null;

    this._playerHitCd = 0;
    this._flashCd = 0;
    this.showFps = false;
    this.phase = "idle";
    this.combatEnabled = false;
    this.countdown = 0;

    const cam = engine.camera;
    cam.followSpeed = GAME.camera.followSpeed;
    cam.shakeDecay = GAME.camera.shakeDecay;
    cam.shakeMax = GAME.camera.shakeMax;

    this.fog = new Fog();
    this.#buildScenery();

    this.hud = new Hud(engine.app);
    this.hud.view.visible = false;
    this.upgradeHud = new UpgradeHud(engine.app);
    this.upgradeHud.view.visible = false;

    engine.app.renderer.on("resize", () => {
      this.hud.layout();
      this.upgradeHud.layout();
    });

    engine.addSystem((dt) => this.update(dt));
  }

  // --- lifecycle ------------------------------------------------------------

  showMenuBackground() {
    this.#resetActors();
    this.#showScenery("waiting");
    this.#setBounds(WORLD.waitingBounds);
    this.engine.camera.follow(null);
    this.engine.camera.x = 0;
    this.engine.camera.y = 0;
    for (let i = 0; i < 5; i++) this.#spawnBot();
    this.phase = "menu";
    this.combatEnabled = false;
    this.hud.view.visible = false;
    this.upgradeHud.view.visible = false;
  }

  enterWaiting(profile) {
    this.profile = profile;
    this.weapon = GAME.weapons[profile.weapon] || GAME.weapons[0];
    this.#resetActors();
    this.#showScenery("waiting");
    this.#setBounds(WORLD.waitingBounds);
    this.#spawnPlayer();
    for (let i = 0; i < GAME.match.waitingBots; i++) this.#spawnBot();
    this.phase = "waiting";
    this.combatEnabled = false;
    this.countdown = GAME.match.countdown;
    this.hud.view.visible = false;
    this.upgradeHud.view.visible = false;
  }

  // Begin the match: real arena, teleport in, fixed BR roster, guardians,
  // pickups, fog. No spawns happen after this point.
  startMatch() {
    this.#showScenery("match");
    this.#setBounds(WORLD.bounds);

    // Drop the player into the OUTER ring (the center is guarded); fill the
    // roster to matchSize with bots (no respawns after this).
    const pa = Math.random() * Math.PI * 2;
    const pr = WORLD.arenaHalf * 0.82;
    this.player.x = Math.cos(pa) * pr;
    this.player.y = Math.sin(pa) * pr;
    for (const bot of this.bots) this.#placeInArena(bot, 1200);
    while (this.bots.length < GAME.match.matchSize - 1) this.#spawnBot();

    this.#spawnGuardians();
    this.#spawnPickups();
    this.fog.reset();

    this.phase = "playing";
    this.combatEnabled = true;
    this.kills = 0;
    this.matchStartTime = performance.now();
    this.input.pressed.clear();
    this.hud.view.visible = true;
    this.upgradeHud.view.visible = true;
    this.upgradeHud.refresh(this.upgrades);
    this.#applyStats();
  }

  setCosmetic(index) {
    if (this.profile) this.profile.cosmetic = index;
    const c = GAME.cosmetics[index] || GAME.cosmetics[0];
    if (this.player) this.player.setColor(c.color);
  }

  setWeapon(index) {
    if (this.profile) this.profile.weapon = index;
    this.weapon = GAME.weapons[index] || GAME.weapons[0];
    if (this.player) this.#applyStats();
  }

  update(dt) {
    if (this.phase === "idle") return;

    if (this.phase === "playing") {
      this.#handleInput();
      if (this._flashCd > 0) this._flashCd -= dt;
    }

    if (this.combatEnabled) {
      if (this.input.isFiring()) this.#firePlayer();
      for (const bot of this.bots) {
        const shot = bot.tryFire();
        if (shot) this.#spawnBullet(shot, "bot");
      }
      for (const gd of this.guardians) {
        if (gd.ai.hasTarget) {
          const shot = gd.tryFire();
          if (shot) this.#spawnBullet(shot, "guardian");
        }
      }
      this.#bulletHits();
      this.#contactDamage(dt);
      this.#collectPickups();
      this.fog.update(dt);
      this.#fogDamage(dt);
      this.#specialsPassive(dt);
    }

    this.#separateBots();

    if (this.phase === "waiting") {
      this.countdown -= dt;
      this.callbacks.onCountdown?.(Math.max(0, this.countdown));
      if (this.countdown <= 0) {
        this.startMatch();
        this.callbacks.onMatchStart?.();
      }
    }

    // Cleanup (deaths are permanent — nothing respawns).
    this.bullets = this.bullets.filter((b) => !b.dead);
    this.bots = this.bots.filter((b) => !b.dead);
    this.guardians = this.guardians.filter((g) => !g.dead);
    this.pickups = this.pickups.filter((p) => !p.dead);
    if (this.sentryDrone && this.sentryDrone.dead) this.sentryDrone = null;
    if (this.lootDrone && this.lootDrone.dead) this.lootDrone = null;

    if (this.phase === "playing") {
      this.#checkWin();
      const alive = this.bots.length + (this.player && !this.player.dead ? 1 : 0);
      this.hud.update(
        {
          hp: this.player.hp,
          maxHp: this.player.maxHp,
          score: this.score,
          alive,
          fps: Math.round(this.engine.app.ticker.FPS),
          showFps: this.showFps,
        },
        dt,
      );
    }
  }

  // --- input + abilities ----------------------------------------------------

  #handleInput() {
    if (this.input.wasPressed("KeyF")) this.showFps = !this.showFps;
    if (this.upgrades.hasSpecial("flash") && this.input.wasPressed("Space")) this.#flash();
  }

  #flash() {
    if (this._flashCd > 0 || !this.player) return;
    const dist = 260;
    this.player.x += Math.cos(this.player.rotation) * dist;
    this.player.y += Math.sin(this.player.rotation) * dist;
    const b = this.bounds;
    const r = this.player.radius;
    this.player.x = Math.min(Math.max(this.player.x, b.minX + r), b.maxX - r);
    this.player.y = Math.min(Math.max(this.player.y, b.minY + r), b.maxY - r);
    this._flashCd = 2.5;
    this.#burst(this.player.x, this.player.y, COLORS.tankBody, 14);
  }

  #specialsPassive(dt) {
    if (this.upgrades.hasSpecial("healing") && this.player && !this.player.dead) {
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + 6 * dt);
    }
  }

  // Base stats + equipped weapon + collected upgrades -> concrete numbers.
  #applyStats() {
    const p = this.player;
    if (!p) return;
    const w = this.weapon || {};
    const u = deriveUpgradeStats(this.upgrades.normals);
    p.speed = GAME.player.speed * u.speedMul;
    p.fireRate = GAME.player.fireRate * u.fireRateMul * (w.fireRateMul || 1);
    p.armor = u.armor;
    this._bulletDamage = GAME.bullet.damage * (w.damageMul || 1);
    this._bulletSpeed = GAME.bullet.speed * u.bulletSpeedMul * (w.bulletSpeedMul || 1);
    this._bulletLife = GAME.bullet.life * u.bulletLifeMul;
  }

  // --- combat ---------------------------------------------------------------

  #firePlayer() {
    const shot = this.player.tryFire();
    if (!shot) return;
    const barrels = this.weapon?.barrels || 1;
    if (barrels === 1) {
      this.#spawnBullet(shot, "player");
      return;
    }
    const spread = 0.16;
    for (let i = 0; i < barrels; i++) {
      const t = i / (barrels - 1) - 0.5;
      this.#spawnBullet({ x: shot.x, y: shot.y, angle: shot.angle + t * spread }, "player");
    }
  }

  #overlap(a, t) {
    const dx = t.x - a.x;
    const dy = t.y - a.y;
    const reach = a.radius + t.radius;
    return dx * dx + dy * dy <= reach * reach;
  }

  #targets() {
    const list = [];
    if (this.player && !this.player.dead) list.push(this.player);
    for (const b of this.bots) list.push(b);
    for (const g of this.guardians) list.push(g);
    return list;
  }

  #bulletHits() {
    const tanks = this.#targets();
    for (const b of this.bullets) {
      if (b.dead) continue;
      for (const t of tanks) {
        if (t.dead || t.team === b.team) continue;
        if (this.#overlap(b, t)) {
          t.takeDamage(b.damage);
          b.dead = true;
          this.#burst(b.x, b.y, COLORS.hitSpark, 5);
          this.#damageNumber(t.x, t.y - t.radius, b.damage);
          if (t.hp <= 0) this.#onTankKilled(t, b.team);
          break;
        }
      }
    }
  }

  #onTankKilled(t, byTeam) {
    if (t === this.player) {
      this.#onPlayerDeath(byTeam === "guardian" ? "a Guardian" : "a Bot");
      return;
    }
    t.dead = true;
    const big = t.team === "guardian";
    this.#burst(t.x, t.y, t.color, big ? 28 : 18);
    this.engine.camera.shake(big ? 14 : 6);
    if (byTeam === "player") {
      this.kills += 1;
      this.score += big ? 500 : GAME.bot.score;
    }
  }

  #contactDamage(dt) {
    if (this._playerHitCd > 0) this._playerHitCd -= dt;
    const p = this.player;
    if (!p || p.dead) return;
    for (const t of [...this.bots, ...this.guardians]) {
      if (t.dead) continue;
      if (this.#overlap(p, t) && this._playerHitCd <= 0) {
        const dmg = t.team === "guardian" ? GAME.guardian.contactDamage : GAME.bot.contactDamage;
        p.takeDamage(dmg);
        this._playerHitCd = GAME.player.contactInvuln;
        this.engine.camera.shake(7);
        if (p.hp <= 0) this.#onPlayerDeath(t.team === "guardian" ? "a Guardian" : "a Bot");
        break;
      }
    }
  }

  // --- fog ------------------------------------------------------------------

  #fogDamage(dt) {
    const dmg = GAME.fog.dps * dt;
    const p = this.player;
    if (p && !p.dead && this.fog.isOutside(p.x, p.y)) {
      p.hp = Math.max(0, p.hp - dmg);
      if (p.hp <= 0) this.#onPlayerDeath("the Toxic Fog");
    }
    for (const bot of this.bots) {
      if (bot.dead) continue;
      if (this.fog.isOutside(bot.x, bot.y)) {
        bot.hp -= dmg;
        if (bot.hp <= 0) {
          bot.dead = true;
          this.#burst(bot.x, bot.y, GAME.fog.color, 8);
        }
      }
    }
  }

  // --- endings --------------------------------------------------------------

  #checkWin() {
    if (this.phase !== "playing") return;
    if (this.player && !this.player.dead && this.bots.length === 0) this.#onWin();
  }

  #onWin() {
    this.phase = "won";
    this.combatEnabled = false;
    const survival = (performance.now() - this.matchStartTime) / 1000;
    this.hud.view.visible = false;
    this.upgradeHud.view.visible = false;
    this.callbacks.onWin?.({
      name: this.profile.displayName,
      title: "CHAMPION",
      kills: this.kills,
      survival,
      score: this.score,
    });
  }

  #onPlayerDeath(killer) {
    if (this.phase !== "playing") return;
    this.phase = "dead";
    this.combatEnabled = false;
    const survival = (performance.now() - this.matchStartTime) / 1000;
    this.#burst(this.player.x, this.player.y, this.player.color, 30);
    this.engine.camera.shake(20);
    this.player.dead = true;
    this.hud.view.visible = false;
    this.upgradeHud.view.visible = false;
    this.callbacks.onMatchEnd?.({ killedBy: killer, survival, kills: this.kills, score: this.score });
  }

  // --- pickups + upgrades ---------------------------------------------------

  #collectPickups() {
    const p = this.player;
    if (!p || p.dead) return;
    const bonus = this.upgrades.hasSpecial("loot") ? 90 : 0; // Loot Drone widens range
    for (const pk of this.pickups) {
      if (pk.dead) continue;
      const reach = p.radius + pk.radius + bonus;
      const dx = pk.x - p.x;
      const dy = pk.y - p.y;
      if (dx * dx + dy * dy <= reach * reach) {
        pk.dead = true;
        this.#applyPickup(pk);
      }
    }
  }

  #applyPickup(pk) {
    if (pk.kind === "special") {
      this.upgrades.collectSpecial(pk.typeKey);
      this.#syncDrones();
      this.#burst(pk.x, pk.y, 0xffd24a, 14);
    } else {
      this.upgrades.collectNormal(pk.typeKey, pk.rarity);
      this.#applyStats();
      this.#burst(pk.x, pk.y, RARITY_COLOR[pk.rarity], 12);
    }
    this.upgradeHud.refresh(this.upgrades);
  }

  // Spawn/despawn drone entities to match the equipped specials.
  #syncDrones() {
    const want = (k) => this.upgrades.hasSpecial(k);
    if (want("sentry") && !this.sentryDrone) {
      this.sentryDrone = new Drone({ kind: "sentry", player: this.player, game: this, phase: 0 });
      this.engine.addEntity(this.sentryDrone);
    } else if (!want("sentry") && this.sentryDrone) {
      this.sentryDrone.dead = true;
      this.sentryDrone = null;
    }
    if (want("loot") && !this.lootDrone) {
      this.lootDrone = new Drone({ kind: "loot", player: this.player, game: this, phase: Math.PI });
      this.engine.addEntity(this.lootDrone);
    } else if (!want("loot") && this.lootDrone) {
      this.lootDrone.dead = true;
      this.lootDrone = null;
    }
  }

  // Place upgrade pickups across the concentric rarity zones (center -> edge).
  #spawnPickups() {
    let inner = 0;
    for (const zone of ZONES) {
      for (let i = 0; i < zone.pickups; i++) {
        const { x, y } = this.#randInRing(inner, zone.maxR);
        const rarity = pickRarity(zone.weights);
        const type = NORMAL_TYPES[(Math.random() * NORMAL_TYPES.length) | 0].key;
        this.#addPickup({ x, y, kind: "normal", typeKey: type, rarity });
      }
      for (let i = 0; i < zone.specials; i++) {
        const { x, y } = this.#randInRing(inner, zone.maxR);
        const sp = SPECIALS[(Math.random() * SPECIALS.length) | 0].key;
        this.#addPickup({ x, y, kind: "special", typeKey: sp });
      }
      inner = zone.maxR;
    }
  }

  #addPickup(opts) {
    const pk = new UpgradePickup(opts);
    this.pickups.push(pk);
    this.engine.addEntity(pk);
  }

  #randInRing(r0, r1) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(r0 * r0 + Math.random() * (r1 * r1 - r0 * r0)); // uniform by area
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  }

  // --- spawning -------------------------------------------------------------

  #spawnPlayer() {
    const c = GAME.cosmetics[this.profile.cosmetic] || GAME.cosmetics[0];
    this.player = new Tank({
      x: 0,
      y: 0,
      input: this.input,
      camera: this.engine.camera,
      bounds: this.bounds,
      color: c.color,
    });
    this.player.team = "player";
    this.engine.addEntity(this.player);
    this.engine.camera.follow(this.player);

    this.nameLabel = new Text({
      text: this.profile.displayName,
      style: { fill: COLORS.hudText, fontFamily: "Arial", fontSize: 13, fontWeight: "bold" },
    });
    this.nameLabel.anchor.set(0.5);
    this.nameLabel.position.set(0, this.player.radius + 18);
    this.player.view.addChild(this.nameLabel);

    this.#applyStats();
  }

  #spawnBot() {
    const bot = new Tank({
      input: null,
      camera: null,
      bounds: this.bounds,
      maxHp: GAME.bot.hp,
      speed: GAME.bot.speed,
      turnRate: GAME.bot.turnRate,
      fireRate: GAME.bot.fireRate,
    });
    this.#placeInArena(bot, 360);
    bot.team = "bot";
    bot.ai = new BotBrain();
    bot.level =
      GAME.bot.levelMin + Math.floor(Math.random() * (GAME.bot.levelMax - GAME.bot.levelMin + 1));
    this.#addLabel(bot, GAME.bot.label, COLORS.hudDim);
    this.bots.push(bot);
    this.engine.addEntity(bot);
  }

  #spawnGuardians() {
    const n = GAME.guardian.count;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 400;
      const gd = new Tank({
        x: Math.cos(a) * r,
        y: Math.sin(a) * r,
        input: null,
        camera: null,
        bounds: this.bounds,
        color: GAME.guardian.color,
        radius: GAME.guardian.radius,
        maxHp: GAME.guardian.hp,
        speed: GAME.guardian.speed,
        turnRate: GAME.guardian.turnRate,
        fireRate: GAME.guardian.fireRate,
      });
      gd.team = "guardian";
      gd.ai = new GuardianBrain(this);
      this.#addLabel(gd, "GUARDIAN", 0xff9a9a);
      this.guardians.push(gd);
      this.engine.addEntity(gd);
    }
  }

  #addLabel(tank, text, fill) {
    const label = new Text({
      text,
      style: { fill, fontFamily: "Arial", fontSize: 12, fontWeight: "bold" },
    });
    label.anchor.set(0.5);
    label.position.set(0, -(tank.radius + 34));
    tank.view.addChild(label);
  }

  #placeInArena(entity, minPlayerDist) {
    const margin = 120;
    const b = this.bounds;
    let x, y;
    do {
      x = b.minX + margin + Math.random() * (b.maxX - b.minX - margin * 2);
      y = b.minY + margin + Math.random() * (b.maxY - b.minY - margin * 2);
    } while (this.player && Math.hypot(x - this.player.x, y - this.player.y) < minPlayerDist);
    entity.x = x;
    entity.y = y;
  }

  #separateBots() {
    const d2max = GAME.bot.separation * GAME.bot.separation;
    for (const a of this.bots) {
      let ax = 0;
      let ay = 0;
      for (const c of this.bots) {
        if (a === c) continue;
        const dx = a.x - c.x;
        const dy = a.y - c.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1 && d2 < d2max) {
          const d = Math.sqrt(d2);
          ax += dx / d;
          ay += dy / d;
        }
      }
      a.ai.avoidX = ax;
      a.ai.avoidY = ay;
    }
  }

  #resetActors() {
    this.engine.removeAllEntities();
    this.player = null;
    this.bullets = [];
    this.bots = [];
    this.guardians = [];
    this.pickups = [];
    this.sentryDrone = null;
    this.lootDrone = null;
    this._playerHitCd = 0;
    this._flashCd = 0;
    this.score = 0;
    this.kills = 0;
    this.upgrades = new UpgradeState();
    this.upgradeHud.refresh(this.upgrades);
  }

  // --- scenery / bounds -----------------------------------------------------

  #buildScenery() {
    this.matchScenery = createArenaFloor(WORLD.bounds);
    this.matchScenery.addChild(createGrid(WORLD.bounds), createArenaBorder(WORLD.bounds));
    this.waitingScenery = createGrid(WORLD.waitingBounds);

    this.engine.addToWorld(this.matchScenery);
    this.engine.addToWorld(this.fog.view); // above the floor, below tanks
    this.engine.addToWorld(this.waitingScenery);
  }

  #showScenery(which) {
    this.matchScenery.visible = which === "match";
    this.fog.view.visible = which === "match";
    this.waitingScenery.visible = which === "waiting";
  }

  #setBounds(bounds) {
    this.bounds = bounds;
    this.engine.camera.bounds = bounds;
    if (this.player) this.player.bounds = bounds;
    for (const bot of this.bots) bot.bounds = bounds;
    for (const gd of this.guardians) gd.bounds = bounds;
  }

  // --- bullets + fx ---------------------------------------------------------

  spawnDroneBullet(x, y, angle) {
    this.#spawnBullet({ x, y, angle }, "player");
  }

  #spawnBullet({ x, y, angle }, team) {
    let speed;
    let damage;
    let life;
    let color = COLORS.tankBody;
    if (team === "player") {
      speed = this._bulletSpeed;
      damage = this._bulletDamage;
      life = this._bulletLife;
    } else if (team === "guardian") {
      speed = GAME.guardian.bulletSpeed;
      damage = GAME.guardian.bulletDamage;
      life = GAME.guardian.bulletLife;
      color = GAME.guardian.color;
    } else {
      speed = GAME.bot.bulletSpeed;
      damage = GAME.bot.bulletDamage;
      life = GAME.bot.bulletLife;
    }
    const b = new Bullet({
      x,
      y,
      angle,
      speed,
      radius: GAME.bullet.radius,
      life,
      damage,
      color,
      bounds: this.bounds,
      team,
    });
    this.bullets.push(b);
    this.engine.addEntity(b);
  }

  #damageNumber(x, y, amount) {
    this.engine.addEntity(new DamageNumber({ x, y, amount: Math.round(amount) }));
  }

  #burst(x, y, color, count) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 80 + Math.random() * 170;
      this.engine.addEntity(
        new Particle({
          x,
          y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s,
          radius: 3 + Math.random() * 3,
          color,
          life: 0.3 + Math.random() * 0.25,
        }),
      );
    }
  }
}
