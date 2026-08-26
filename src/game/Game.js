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

import { Text, Graphics } from "pixi.js";
import { Tank } from "../entities/Tank.js";
import { Bullet } from "../entities/Bullet.js";
import { Particle } from "../entities/Particle.js";
import { DamageNumber } from "../entities/DamageNumber.js";
import { UpgradePickup } from "../entities/UpgradePickup.js";
import { Crate } from "../entities/Crate.js";
import { Wall } from "../entities/Wall.js";
import { Drone } from "../entities/Drone.js";
import { BotBrain } from "./BotBrain.js";
import { tierIndex, WEAPON_STYLES } from "./ai/BotProfile.js";

// All bots wield the Standard turret for now → the Standard positioning style.
const STANDARD_STYLE = WEAPON_STYLES.find((s) => s.name === "standard");
import { botCanUse } from "./ai/context.js";
import { pickSavedPolicy } from "./ai/trainer/evolve.js";
import { makeNameGen } from "./ai/names.js";
import { GuardianBrain } from "./GuardianBrain.js";
import { circleOverlap } from "../sim/physics.js";
import { Fog } from "./Fog.js";
import { UpgradeState } from "./UpgradeState.js";
import { earnedXp } from "./IronPath.js";
import { recordAchievement } from "./Progression.js";
import {
  ZONES,
  NORMAL_TYPES,
  SPECIALS,
  RARITY_COLOR,
  RARITY_MUL,
  pickRarity,
  deriveUpgradeStats,
} from "./upgrades.js";
import { Hud } from "../ui/Hud.js";
import { UpgradeHud } from "../ui/UpgradeHud.js";
import { Minimap } from "../ui/Minimap.js";
import { createGrid } from "../render/Grid.js";
import { createArenaFloor, createArenaBorder } from "../render/Arena.js";
import { COLORS, WORLD, GAME } from "../config.js";

// Cycled by the "rainbow" cosmetic trail.
const HSV = [0xff5555, 0xffa53a, 0xffd24a, 0x76d672, 0x4aa3ff, 0x9b6cff];

// A cosmetic color's FX gradient as [c1, c2, dir], or null for a flat color.
const gradOf = (c) => (c && c.gradient ? [c.gradient[0], c.gradient[1], c.dir] : null);

// Dark outline behind nametags so they stay legible on the light world.
const NAME_STROKE = { color: 0x1c2029, width: 3, join: "round" };
// Team nametag colors (player = white, enemies = light red).
const ENEMY_NAME = 0xff8a8a;

export class Game {
  // callbacks: { onCountdown(s), onMatchStart(), onMatchEnd(stats), onWin(stats),
  //   onAchievements(def) }
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
    this.crates = [];
    this.walls = [];
    this.player = null;
    this.profile = null;
    this._botSeq = 0; // per-bot unique team id counter
    this._nameGen = makeNameGen(); // unique bot names for the current lobby
    this.weapon = GAME.weapons[0];
    this.upgrades = new UpgradeState();
    this.sentryDrone = null;
    this.lootDrone = null;

    this._playerHitCd = 0;
    this._flashCd = 0;
    this._trailCd = 0;
    this._rainbow = 0;
    this._salvo = []; // scheduled staggered shots (Penta / Burst): { t, shot }
    this._rockets = []; // live player rockets awaiting SHIFT detonation
    this._laserTick = 0; // laser damage-tick timer
    this._laser = null; // resolved laser stats (tickDamage/tickRate) for this weapon
    this._laserHeat = 0; // laser heat buildup (seconds)
    this._laserLocked = 0; // overheat lockout remaining (seconds)
    this._laserInterrupt = 0; // early-release lockout remaining (seconds)
    this._firedLaser = false; // was the laser actively firing last frame
    this.swapPrompt = null; // special pickup overlapped while holding 2 (press F)
    this.showFps = false;
    this.phase = "idle";
    this.combatEnabled = false; // shooting allowed (waiting room + match)
    this.damageEnabled = false; // hits/kills/upgrades/fog register (match only)
    this.countdown = 0;

    const cam = engine.camera;
    cam.followSpeed = GAME.camera.followSpeed;
    cam.shakeDecay = GAME.camera.shakeDecay;
    cam.shakeMax = GAME.camera.shakeMax;

    this.fog = new Fog();
    this.#buildScenery();

    // World-space beam for the Laser Rifle (drawn fresh each frame while firing).
    this._laserBeam = new Graphics();
    this.engine.addToWorld(this._laserBeam);

    this.hud = new Hud(engine.app);
    this.hud.view.visible = false;
    this.upgradeHud = new UpgradeHud(engine.app);
    this.upgradeHud.view.visible = false;
    this.minimap = new Minimap(engine.app);
    this.minimap.view.visible = false;

    engine.app.renderer.on("resize", () => {
      this.hud.layout();
      this.upgradeHud.layout();
      this.minimap.layout();
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
    // Menu is "alive": bots wander + shoot harmlessly (no damage) behind the UI.
    this.combatEnabled = true;
    this.damageEnabled = false;
    this._menuT = 0;
    this.hud.view.visible = false;
    this.upgradeHud.view.visible = false;
    this.minimap.view.visible = false;
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
    // Waiting room: shooting + previews ON for loadout testing, but no damage,
    // kills, upgrades, or XP.
    this.combatEnabled = true;
    this.damageEnabled = false;
    this.countdown = GAME.match.countdown;
    this.hud.view.visible = false;
    this.upgradeHud.view.visible = false;
    this.minimap.view.visible = false;
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

    this.#spawnWalls();
    this.#spawnGuardians();
    this.#spawnPickups();
    this.#spawnCrates();
    this.fog.reset();

    this.phase = "playing";
    this.combatEnabled = true;
    this.damageEnabled = true;
    this.kills = 0;
    this.matchStartTime = performance.now();
    this.input.pressed.clear();
    this.hud.view.visible = true;
    this.upgradeHud.view.visible = true;
    this.minimap.view.visible = true;
    this.upgradeHud.refresh(this.upgrades);
    this.#applyStats();
  }

  setCosmetic(index) {
    if (this.profile) this.profile.cosmetic = index;
    const c = GAME.cosmetics[index] || GAME.cosmetics[0];
    if (this.player) this.player.setColor(c.color, gradOf(c));
  }

  setWrap(index) {
    if (this.profile) this.profile.wrap = index;
    const w = GAME.wraps[index] || GAME.wraps[0];
    if (this.player) this.player.setWrap(w.pattern);
  }

  setTrail(index) {
    if (this.profile) this.profile.trail = index; // read live in #emitTrail
  }

  setKillFx(index) {
    if (this.profile) this.profile.killFx = index; // read live on a kill
  }

  setTitle(index) {
    if (this.profile) this.profile.title = index;
    const t = GAME.titles[index] || GAME.titles[0];
    if (this.titleLabel) {
      // "No Title" hides the label entirely; FX titles keep their bold styling.
      this.titleLabel.visible = !t.none;
      this.titleLabel.text = t.none ? "" : `[${t.name}]`;
      this.titleLabel.style.fill = t.color ?? COLORS.xpFill;
      this.titleLabel.style.fontWeight = t.bold ? "bold" : "normal";
    }
  }

  setWeapon(index) {
    if (this.profile) this.profile.weapon = index;
    this.weapon = GAME.weapons[index] || GAME.weapons[0];
    if (this.player) {
      this.player.setWeapon(this.weapon); // swap the visible turret
      this.#applyStats();
    }
  }

  update(dt) {
    if (this.phase === "idle" || this.paused) return; // paused while the multiplayer mode owns the engine

    if (this.phase === "menu") this.#driftMenuCamera(dt);

    if (this.phase === "playing") {
      this.#handleInput();
      if (this._flashCd > 0) this._flashCd -= dt;
    }

    // Shooting is allowed in the waiting room too (loadout testing), but only the
    // live match resolves hits, upgrades, fog, and the endgame.
    if (this.combatEnabled) {
      // Player weapon dispatch: laser is a continuous beam; everything else is
      // cooldown-gated projectile fire. Staggered shots drain from the salvo.
      if (this.weapon?.fireMode === "laser") {
        this.#fireLaser(dt, this.player && this.input.isFiring());
      } else {
        this._laserBeam.clear();
        if (this.player && this.input.isFiring()) this.#firePlayer();
      }
      this.#processSalvo(dt);
      for (const bot of this.bots) {
        // Live match: bots fire only when their brain intends to. Calm scenes
        // (menu / waiting room): the occasional harmless shot for atmosphere.
        const wants = this.damageEnabled ? bot.ai.wantsFire : Math.random() < 0.004;
        if (wants) {
          const shot = bot.tryFire();
          if (shot) this.#spawnBullet(shot, bot.team, bot); // bot's own team -> friendly fire off vs self only
        }
      }
      for (const gd of this.guardians) {
        if (gd.ai.hasTarget) {
          const shot = gd.tryFire();
          if (shot) this.#spawnBullet(shot, "guardian");
        }
      }
    }

    if (this.damageEnabled) {
      this.#bulletHits();
      this.#bulletCrates();
      this.#contactDamage(dt);
      this.#collectPickups();
      this.#botPickups();
      this.#rocketTrails(dt);
      this.fog.update(dt, this.#fogIntensity());
      this.#fogDamage(dt);
      this.#consumeLootInFog();
      this.#specialsPassive(dt);
    }

    this.#separateBots();
    if (this.walls.length) this.#resolveWalls();
    if (this.phase === "waiting" || this.phase === "playing") this.#emitTrail(dt);

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
    this.crates = this.crates.filter((c) => !c.dead);
    this.walls = this.walls.filter((w) => !w.dead);
    if (this._rockets.length) this._rockets = this._rockets.filter((r) => !r.dead);
    if (this.sentryDrone && this.sentryDrone.dead) this.sentryDrone = null;
    if (this.lootDrone && this.lootDrone.dead) this.lootDrone = null;

    if (this.phase === "playing") {
      this.#checkWin();
      const alive = this.bots.length + (this.player && !this.player.dead ? 1 : 0);
      const outside = this.player && !this.player.dead && this.fog.isOutside(this.player.x, this.player.y);
      this.hud.update(
        {
          hp: this.player.hp,
          maxHp: this.player.maxHp,
          score: this.score,
          alive,
          fps: Math.round(this.engine.app.ticker.FPS),
          showFps: this.showFps,
          fogWarning: outside,
        },
        dt,
      );
      this.minimap.update({
        player: this.player,
        bots: this.bots,
        walls: this.walls,
        fogRadius: this.fog.radius,
        fogNextRadius: this.fog.nextRadius,
        fogTimer: this.fog.timer,
        fogShrinking: this.fog.state === "shrinking",
        fogFinal: this.fog.nextRadius === null,
        radar: this.upgrades.hasSpecial("radar"),
      });
    }
  }

  // Slow drifting camera behind the main menu so the scene feels alive.
  #driftMenuCamera(dt) {
    this._menuT = (this._menuT || 0) + dt;
    const cam = this.engine.camera;
    cam.x = Math.cos(this._menuT * 0.12) * 320;
    cam.y = Math.sin(this._menuT * 0.09) * 220;
  }

  // --- endgame --------------------------------------------------------------

  // Total tanks still in the running (player + bots; guardians are environmental).
  #aliveCount() {
    return this.bots.length + (this.player && !this.player.dead ? 1 : 0);
  }

  // Fog shrink multiplier: accelerates as the roster thins, dominating the map
  // in the final phase so encounters are forced.
  #fogIntensity() {
    const alive = this.#aliveCount();
    if (alive <= GAME.endgame.finalAt) return GAME.endgame.finalMul;
    if (alive <= GAME.endgame.compressAt) return GAME.endgame.compressMul;
    return 1;
  }

  // Loot left outside the shrinking safe zone is lost to the fog — so crates
  // (and pickups) naturally become rarer as the endgame closes in.
  #consumeLootInFog() {
    for (const c of this.crates) {
      if (!c.dead && this.fog.isOutside(c.x, c.y)) {
        c.dead = true;
        this.#burst(c.x, c.y, GAME.fog.color, 6);
      }
    }
    for (const p of this.pickups) {
      if (!p.dead && this.fog.isOutside(p.x, p.y)) p.dead = true;
    }
  }

  // --- input + abilities ----------------------------------------------------

  #handleInput() {
    if (this.input.wasPressed("KeyF")) {
      // F swaps the held special when prompted; otherwise it toggles the FPS readout.
      if (this.swapPrompt && !this.swapPrompt.dead) {
        const pk = this.swapPrompt;
        const dropped = this.upgrades.specials[0]; // FIFO: the oldest is replaced
        pk.dead = true;
        this.#applyPickup(pk); // collectSpecial drops the oldest, adds the new one
        if (dropped) this.#dropSpecial(dropped); // physically eject the replaced one
        this.#setSwapPrompt(null);
      } else {
        this.showFps = !this.showFps;
      }
    }
    // Always consume the Space edge (even without Flash) so a stale press can't
    // queue up and auto-trigger a dash the instant Flash is picked up/swapped in.
    const dashPressed = this.input.wasPressed("Space");
    if (dashPressed && this.upgrades.hasSpecial("flash")) this.#flash();

    // SHIFT detonates any Rocketeer rockets currently in flight.
    const shift = this.input.wasPressed("ShiftLeft") || this.input.wasPressed("ShiftRight");
    if (shift && this.weapon?.fireMode === "rocket") this.#detonateRockets();
  }

  // Flash dash: teleport a short distance in the facing direction. Fires ONLY on
  // Space (see #handleInput) and respects a cooldown — equipping never triggers
  // it. Leaves a dash trail of particles between the start and end points.
  #flash() {
    if (this._flashCd > 0 || !this.player) return;
    const p = this.player;
    const dist = 260;
    const sx = p.x;
    const sy = p.y;
    p.x += Math.cos(p.rotation) * dist;
    p.y += Math.sin(p.rotation) * dist;
    const b = this.bounds;
    const r = p.radius;
    p.x = Math.min(Math.max(p.x, b.minX + r), b.maxX - r);
    p.y = Math.min(Math.max(p.y, b.minY + r), b.maxY - r);
    this._flashCd = 2.5;
    const steps = 6; // small dash particles along the path
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.#burst(sx + (p.x - sx) * t, sy + (p.y - sy) * t, COLORS.tankBody, 3);
    }
  }

  #specialsPassive(dt) {
    if (this.upgrades.hasSpecial("healing") && this.player && !this.player.dead) {
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + 6 * dt);
    }
  }

  // Base stats + equipped weapon + collected upgrades -> concrete numbers. Every
  // value comes from the weapon's config entry (no hardcoding here).
  #applyStats() {
    const p = this.player;
    if (!p) return;
    const w = this.weapon || {};
    const u = deriveUpgradeStats(this.upgrades.normals);
    const shot0 = w.shots?.[0];

    p.speed = GAME.player.speed * u.speedMul * (w.moveMul || 1);
    p.moveScale = 1;
    p.armor = u.armor;
    p.recoilAmount = w.recoil ?? GAME.player.recoil;
    // Fire interval (laser is continuous, so cooldown 0). Reload upgrades shorten it.
    p.fireRate = (w.cooldown ?? GAME.player.fireRate) * u.fireRateMul;

    // Default projectile stats (used by the player's shots + drone bullets).
    this._bulletSpeed = (w.bulletSpeed ?? GAME.bullet.speed) * u.bulletSpeedMul;
    this._bulletLife = (w.bulletLife ?? GAME.bullet.life) * u.bulletLifeMul;
    this._bulletRadius = w.bulletRadius ?? GAME.bullet.radius;
    this._bulletDamage = shot0?.damage ?? GAME.bullet.damage;
    this._armorMul = 1 - (w.armorPen || 0); // <1 pierces armor

    // Laser: its Bullet-Speed / Reload pickups are re-purposed as Laser Damage /
    // Laser Lethality (local to laser users); other weapons are unaffected.
    if (w.fireMode === "laser") {
      const raw = (key) => (key in this.upgrades.normals ? RARITY_MUL[this.upgrades.normals[key]] : 0);
      const L = w.laser;
      this._laser = {
        tickDamage: L.tickDamage + 1 * raw("bulletSpeed"), // +1 dmg/tick per level
        tickRate: L.tickRate * Math.max(0.4, 1 - 0.05 * raw("reloadSpeed")), // faster ticks
      };
    } else {
      this._laser = null;
    }
    // Relabel the two re-purposed upgrade slots when the Laser is equipped.
    this.upgradeHud.setLaserMode(w.fireMode === "laser");
    // Sniper widens the view (increased FOV) via a slight camera zoom-out.
    this.engine.camera.zoom = w.fovMul ?? 1;
  }

  // --- combat ---------------------------------------------------------------

  #firePlayer() {
    const shot = this.player.tryFire(); // cooldown gate + per-weapon recoil
    if (!shot) return;
    const w = this.weapon;
    if (w.fireMode === "rocket") {
      this.#fireRocket(w);
      return;
    }
    // Burst: fire `count` standard shots rapidly, then the cooldown is the reload.
    if (w.fireMode === "burst") {
      const base = w.shots[0];
      for (let i = 0; i < w.burst.count; i++) {
        if (i === 0) this.#spawnShot(base);
        else this._salvo.push({ t: i * w.burst.interval, shot: base });
      }
      return;
    }
    for (const s of w.shots || [{ damage: this._bulletDamage }]) {
      if (s.delay > 0) this._salvo.push({ t: s.delay, shot: s });
      else this.#spawnShot(s);
    }
  }

  // Fire the delayed shots of a staggered salvo (Penta-Shot's side/outer pairs).
  #processSalvo(dt) {
    if (!this._salvo.length) return;
    for (const e of this._salvo) {
      e.t -= dt;
      if (e.t <= 0) this.#spawnShot(e.shot);
    }
    this._salvo = this._salvo.filter((e) => e.t > 0);
  }

  // Spawn one weapon shot from its barrel muzzle (perp offset + angle + spread).
  #spawnShot(s) {
    const p = this.player;
    if (!p || p.dead) return;
    const w = this.weapon;
    const rot = p.rotation;
    const baseAng = rot + (s.angle || 0);
    const fireAng = baseAng + (Math.random() - 0.5) * (w.spread || 0);
    const md = s.muzzle ?? w.muzzle ?? p.radius * 2.2;
    const perpX = -Math.sin(baseAng);
    const perpY = Math.cos(baseAng);
    const x = p.x + Math.cos(baseAng) * md + perpX * (s.perp || 0);
    const y = p.y + Math.sin(baseAng) * md + perpY * (s.perp || 0);
    this.#muzzleFlash(x, y, fireAng);
    this.#spawnWeaponBullet({
      x,
      y,
      angle: fireAng,
      speed: this._bulletSpeed * (s.speedMul || 1),
      damage: s.damage,
      radius: this._bulletRadius * (s.radiusMul || 1),
      life: this._bulletLife,
      armorMul: this._armorMul,
      pierce: w.pierce || 0,
    });
  }

  // Construct + register a player weapon bullet.
  #spawnWeaponBullet(o) {
    const b = new Bullet({
      x: o.x,
      y: o.y,
      angle: o.angle,
      speed: o.speed,
      radius: o.radius,
      life: o.life,
      damage: o.damage,
      color: COLORS.tankBody,
      bounds: this.bounds,
      team: "player",
      shape: o.shape || "circle",
      armorMul: o.armorMul ?? 1,
      pierce: o.pierce || 0,
      knockback: o.knockback || 0,
      isRocket: o.isRocket || false,
    });
    this.bullets.push(b);
    this.engine.addEntity(b);
    return b;
  }

  // Rocketeer: launch a slow hex rocket the player can later SHIFT-detonate.
  #fireRocket(w) {
    const p = this.player;
    const rot = p.rotation;
    const md = w.muzzle ?? p.radius * 2.2;
    const r = w.rocket;
    const rocket = this.#spawnWeaponBullet({
      x: p.x + Math.cos(rot) * md,
      y: p.y + Math.sin(rot) * md,
      angle: rot,
      speed: r.speed,
      damage: r.damage,
      radius: r.radius,
      life: r.life,
      shape: "arrow",
      isRocket: true,
    });
    rocket._trailT = r.trail?.interval ?? 0; // timer for rear-fired mini bullets
    this.#muzzleFlash(rocket.x, rocket.y, rot);
    this._rockets.push(rocket);
  }

  // Rocketeer rockets spray small bullets out their BACK as they fly forward.
  #rocketTrails(dt) {
    const trail = this.weapon?.rocket?.trail;
    if (!trail || !this._rockets.length) return;
    for (const rk of this._rockets) {
      if (rk.dead) continue;
      rk._trailT = (rk._trailT ?? trail.interval) - dt;
      if (rk._trailT <= 0) {
        rk._trailT = trail.interval;
        this.#spawnWeaponBullet({
          x: rk.x,
          y: rk.y,
          angle: rk.angle + Math.PI, // out the back
          speed: trail.speed,
          damage: trail.damage,
          radius: trail.size,
          life: 0.8,
          shape: "circle",
        });
      }
    }
  }

  // Detonate every live rocket into two star-pellet layers + an AoE blast.
  #detonateRockets() {
    const det = this.weapon.rocket?.detonate;
    if (!det) return;
    for (const rk of this._rockets) if (!rk.dead) this.#detonate(rk, det);
    this._rockets = this._rockets.filter((r) => !r.dead);
  }

  #detonate(rk, det) {
    rk.dead = true;
    this.#burst(rk.x, rk.y, 0xffa53a, 20);
    this.#burst(rk.x, rk.y, 0xe2564b, 12);
    this.engine.camera.shake(8);

    // AoE bonus damage + knockback to enemies inside the blast radius.
    for (const t of this.#targets()) {
      if (t.dead || t.team === "player") continue;
      const dx = t.x - rk.x;
      const dy = t.y - rk.y;
      const d = Math.hypot(dx, dy);
      if (d > det.explodeRadius + t.radius) continue;
      t.takeDamage(det.bonusDamage);
      this.#damageNumber(t.x, t.y - t.radius, det.bonusDamage);
      if (d > 1) {
        const nx = dx / d;
        const ny = dy / d;
        t.x += nx * 8;
        t.y += ny * 8;
        t.vx += nx * det.knockback;
        t.vy += ny * det.knockback;
      }
      if (t.hp <= 0) this.#onTankKilled(t, "player");
    }

    // Two expanding star-pellet rings.
    for (const layer of det.layers) {
      for (let i = 0; i < layer.count; i++) {
        const a = (i / layer.count) * Math.PI * 2;
        this.#spawnWeaponBullet({
          x: rk.x,
          y: rk.y,
          angle: a,
          speed: layer.speed,
          damage: layer.damage,
          radius: layer.size,
          life: 0.7,
          shape: "star",
        });
      }
    }
  }

  // Laser Rifle: a continuous instant-hit beam that BUILDS HEAT. After `heatTime`
  // of use it overheats (locked out for `coolTime`); releasing early triggers an
  // `interruptCooldown`. The barrel glows red with heat. Redrawn each frame.
  #fireLaser(dt, firing) {
    const beam = this._laserBeam.clear();
    const p = this.player;
    const L = this.weapon.laser;

    // Tick down lockouts (even when not firing).
    if (this._laserLocked > 0) this._laserLocked -= dt;
    if (this._laserInterrupt > 0) this._laserInterrupt -= dt;
    const lockedOut = this._laserLocked > 0 || this._laserInterrupt > 0;
    const active = firing && p && !p.dead && !lockedOut;

    if (!active) {
      if (p) p.moveScale = 1;
      this._laserTick = 0;
      // Released before overheating -> short interrupt cooldown, then reset.
      if (this._firedLaser && !lockedOut && this._laserHeat > 0 && this._laserHeat < L.heatTime) {
        this._laserInterrupt = L.interruptCooldown;
      }
      this._firedLaser = false;
      // Bleed heat back down (over coolTime when overheated / interrupted, else same rate).
      const drainOver = this._laserInterrupt > 0 ? L.interruptCooldown : L.coolTime;
      this._laserHeat = Math.max(0, this._laserHeat - dt * (L.heatTime / drainOver));
      if (p) p.setBarrelHeat(this._laserHeat / L.heatTime);
      return;
    }

    // Firing: accumulate heat; overheat locks the beam out.
    this._laserHeat += dt;
    this._firedLaser = true;
    if (this._laserHeat >= L.heatTime) {
      this._laserHeat = L.heatTime;
      this._laserLocked = L.coolTime;
      this._firedLaser = false;
      p.moveScale = 1;
      this._laserTick = 0;
      p.setBarrelHeat(1);
      return; // beam cuts out this frame
    }
    p.setBarrelHeat(this._laserHeat / L.heatTime);
    p.moveScale = L.moveMul; // slowed while firing

    const rot = p.rotation;
    const md = this.weapon.muzzle ?? p.radius * 2.2;
    const ox = p.x + Math.cos(rot) * md;
    const oy = p.y + Math.sin(rot) * md;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);

    // Raycast to the FIRST solid thing within the configured max range: enemy
    // tanks, crates, and walls all block the beam (it never passes through).
    const { dist, target, kind } = this.#raycast(ox, oy, cos, sin, L.range);

    // Draw the beam up to the hit point (glow + hot core).
    const ex = ox + cos * dist;
    const ey = oy + sin * dist;
    beam.moveTo(ox, oy).lineTo(ex, ey).stroke({ color: 0xff3b3b, width: L.width, alpha: 0.85 });
    beam.moveTo(ox, oy).lineTo(ex, ey).stroke({ color: 0xffd0d0, width: L.width * 0.4, alpha: 0.95 });

    // Tick damage on whatever the beam is hitting (match only). Walls just block.
    if (this.damageEnabled && (kind === "tank" || kind === "crate")) {
      this._laserTick -= dt;
      if (this._laserTick <= 0) {
        this._laserTick = this._laser.tickRate;
        this.#burst(ex, ey, 0xff8a3a, 3);
        if (kind === "tank") {
          target.takeDamage(this._laser.tickDamage, 1 + L.armorVuln);
          if (target.hp <= 0) this.#onTankKilled(target, "player");
        } else {
          target.takeDamage(this._laser.tickDamage); // crate: chip then break + scatter
          if (target.hp <= 0) this.#breakCrate(target);
        }
      }
    } else {
      this._laserTick = 0;
    }
  }

  // Cast a ray from (ox,oy) along the unit direction (cos,sin), up to maxDist.
  // Returns the nearest blocker: { dist, target, kind } where kind is
  // "tank" | "crate" | "wall" | null (nothing hit -> dist = maxDist).
  #raycast(ox, oy, cos, sin, maxDist) {
    let best = maxDist;
    let target = null;
    let kind = null;

    for (const t of this.#targets()) {
      if (t.dead || t.team === "player") continue; // don't hit the shooter's team
      const d = this.#rayCircle(ox, oy, cos, sin, t.x, t.y, t.radius, best);
      if (d != null && d < best) {
        best = d;
        target = t;
        kind = "tank";
      }
    }
    for (const c of this.crates) {
      if (c.dead) continue;
      const d = this.#rayAabb(ox, oy, cos, sin, c.minX, c.minY, c.maxX, c.maxY, best);
      if (d != null && d < best) {
        best = d;
        target = c;
        kind = "crate";
      }
    }
    for (const w of this.walls) {
      const d = this.#rayAabb(ox, oy, cos, sin, w.minX, w.minY, w.maxX, w.maxY, best);
      if (d != null && d < best) {
        best = d;
        target = w;
        kind = "wall";
      }
    }
    return { dist: best, target, kind };
  }

  // Ray vs circle -> entry distance along the ray, or null if it misses / is past maxT.
  #rayCircle(ox, oy, dx, dy, cx, cy, r, maxT) {
    const mx = ox - cx;
    const my = oy - cy;
    const b = mx * dx + my * dy;
    const c = mx * mx + my * my - r * r;
    if (c > 0 && b > 0) return null; // outside and pointing away
    const disc = b * b - c;
    if (disc < 0) return null;
    let t = -b - Math.sqrt(disc);
    if (t < 0) t = 0; // ray origin inside the circle
    return t > maxT ? null : t;
  }

  // Ray vs axis-aligned box (slab method) -> entry distance, or null.
  #rayAabb(ox, oy, dx, dy, minX, minY, maxX, maxY, maxT) {
    let tmin = 0;
    let tmax = maxT;
    if (Math.abs(dx) < 1e-8) {
      if (ox < minX || ox > maxX) return null;
    } else {
      let t1 = (minX - ox) / dx;
      let t2 = (maxX - ox) / dx;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
    if (Math.abs(dy) < 1e-8) {
      if (oy < minY || oy > maxY) return null;
    } else {
      let t1 = (minY - oy) / dy;
      let t2 = (maxY - oy) / dy;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
    return tmin > maxT ? null : tmin;
  }

  // A brief warm spark cone at the muzzle on each shot (combat feel).
  #muzzleFlash(x, y, angle) {
    for (let i = 0; i < 4; i++) {
      const a = angle + (Math.random() - 0.5) * 0.5;
      const s = 120 + Math.random() * 130;
      this.engine.addEntity(
        new Particle({
          x,
          y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s,
          radius: 2 + Math.random() * 2,
          color: 0xfff2c0,
          life: 0.1 + Math.random() * 0.08,
        }),
      );
    }
  }

  #overlap(a, t) {
    // Circle-vs-circle via the SHARED simulation primitive (src/sim/physics.js).
    return circleOverlap(a.x, a.y, a.radius, t.x, t.y, t.radius);
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
        if (b.hitSet && b.hitSet.has(t)) continue; // piercing round: don't re-hit
        if (this.#overlap(b, t)) {
          t.takeDamage(b.damage, b.armorMul);
          this.#burst(b.x, b.y, COLORS.hitSpark, 5);
          this.#damageNumber(t.x, t.y - t.radius, b.damage);
          if (b.knockback) {
            const dx = t.x - b.x;
            const dy = t.y - b.y;
            const d = Math.hypot(dx, dy) || 1;
            t.vx += (dx / d) * b.knockback;
            t.vy += (dy / d) * b.knockback;
          }
          if (t.hp <= 0) this.#onTankKilled(t, b.team, b.owner); // b.owner = the firing tank (kill attribution)
          // Piercing rounds (Railgun) pass through a few targets before dying.
          if (b.pierce > 0) {
            b.pierce--;
            (b.hitSet ||= new Set()).add(t);
          } else {
            b.dead = true;
          }
          break;
        }
      }
    }
  }

  #onTankKilled(t, byTeam, killer = null) {
    if (t === this.player) {
      // Attribute to the specific killer entity when known (a bot); guardians/fog
      // stay generic. The death screen uses this to draw the killer's tank.
      this.#onPlayerDeath(byTeam === "guardian" ? "a Guardian" : killer || "a Bot");
      return;
    }
    t.dead = true;
    const big = t.team === "guardian";
    this.#burst(t.x, t.y, t.color, big ? 28 : 18);
    this.#shakeAt(t.x, t.y, big ? 14 : 6);
    if (byTeam === "player") {
      this.kills += 1;
      this.score += big ? 500 : GAME.bot.score;
      this.#killEffect(t.x, t.y, t.color); // cosmetic kill FX
      this.#award("first_blood"); // "A Moment to Cherish Forever"
      if (big) this.#award("unstoppable"); // killed an Arena Guardian
    }
  }

  // Record achievement progress; if it newly completes, persist + announce it
  // (the GameFlow shows a completion toast).
  #award(id, amount = 1) {
    if (!this.profile) return;
    const def = recordAchievement(this.profile, id, amount);
    if (def) {
      this.profile.save();
      this.callbacks.onAchievements?.(def);
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
        if (p.hp <= 0) this.#onPlayerDeath(t.team === "guardian" ? "a Guardian" : t); // t = the bot that rammed us
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
    this.damageEnabled = false;
    const survival = (performance.now() - this.matchStartTime) / 1000;
    this.hud.view.visible = false;
    this.upgradeHud.view.visible = false;
    this.minimap.view.visible = false;
    this.#award("victor"); // "The Victorious One"
    const xp = this.#awardXp(survival, true);
    this.callbacks.onWin?.({
      name: this.profile.displayName,
      title: "CHAMPION",
      kills: this.kills,
      survival,
      score: this.score,
      xp,
    });
  }

  #onPlayerDeath(killer) {
    if (this.phase !== "playing") return;
    this.phase = "dead";
    this.combatEnabled = false;
    this.damageEnabled = false;
    const survival = (performance.now() - this.matchStartTime) / 1000;
    this.#burst(this.player.x, this.player.y, this.player.color, 30);
    this.engine.camera.shake(20);
    this.player.dead = true;
    this.hud.view.visible = false;
    this.upgradeHud.view.visible = false;
    this.minimap.view.visible = false;
    const xp = this.#awardXp(survival, false);
    const info = this.#killerInfo(killer);
    this.callbacks.onMatchEnd?.({ killedBy: info.text, killer: info, survival, kills: this.kills, score: this.score, xp });
  }

  // Build the death-screen "Killed By" info. When the killer is a tank entity (a
  // bot, or a human player in multiplayer), include enough to draw its actual tank
  // (color/wrap/turret) + name + title. Guardians and the fog stay text-only.
  #killerInfo(k) {
    if (k && typeof k === "object" && k.team && k !== this.player) {
      if (k.team === "guardian") return { text: "a Guardian" };
      const name = k.name || "a Tank";
      return {
        text: name,
        tank: { color: k.color, gradient: k.gradient || null, wrap: k.wrap || "none", turret: k.turret || "single" },
        name,
        title: k.killerTitle || null, // { name, color, bold }; bots have none
      };
    }
    return { text: typeof k === "string" ? k : "a Bot" };
  }

  // Compute Iron Path XP for the finished match, add it to the profile, persist,
  // and return the amount earned (for the results screen).
  #awardXp(survival, won) {
    const xp = earnedXp({ kills: this.kills, survival, won });
    if (this.profile) {
      this.profile.addIronPathXp(xp);
      this.profile.save();
    }
    return xp;
  }

  // --- pickups + upgrades ---------------------------------------------------

  #collectPickups() {
    const p = this.player;
    if (!p || p.dead) {
      this.#setSwapPrompt(null);
      return;
    }
    const bonus = this.upgrades.hasSpecial("loot") ? 90 : 0; // Loot Drone widens range
    let swap = null;
    for (const pk of this.pickups) {
      if (pk.dead || !pk.collectable) continue; // freshly scattered loot has a delay
      const reach = p.radius + pk.radius + bonus;
      const dx = pk.x - p.x;
      const dy = pk.y - p.y;
      if (dx * dx + dy * dy > reach * reach) continue;

      if (pk.kind === "special") {
        if (this.upgrades.hasSpecial(pk.typeKey)) continue; // already own it -> ghost, skip
        if (this.upgrades.specials.length < 2) {
          pk.dead = true;
          this.#applyPickup(pk);
        } else {
          swap = pk; // holding 2 -> require [F] to swap the oldest
        }
      } else {
        if (this.#isRedundant(pk)) continue; // already own equal/better -> ghost, skip
        pk.dead = true;
        this.#applyPickup(pk);
      }
    }
    this.#setSwapPrompt(swap);
  }

  // A pickup is redundant (ghosted, uncollectable) when the player already owns
  // it: that special, or that normal type at an equal/higher rarity.
  #isRedundant(pk) {
    if (pk.kind === "special") return this.upgrades.hasSpecial(pk.typeKey);
    const cur = this.upgrades.normals[pk.typeKey];
    return cur !== undefined && cur >= pk.rarity;
  }

  // Recompute the ghosted state of every pickup (after upgrades change).
  #updateGhosts() {
    for (const pk of this.pickups) {
      if (!pk.dead) pk.ghost = this.#isRedundant(pk);
    }
  }

  // Bots collect world upgrade pickups through the SAME authoritative system, under
  // the SAME conditions a player must satisfy: any USABLE, collectable pickup whose
  // circle the bot physically overlaps is picked up (not just its cached target) —
  // so a bot standing on an upgrade always collects it, no radius inflation. Ignores
  // specials + already-owned upgrades (botCanUse) and freshly-scattered loot still in
  // its pickup delay (collectable), exactly like #collectPickups.
  #botPickups() {
    if (!this.pickups.length) return;
    for (const bot of this.bots) {
      if (bot.dead) continue;
      for (const pk of this.pickups) {
        if (pk.dead || !pk.collectable || !botCanUse(pk, bot)) continue;
        const reach = bot.radius + pk.radius;
        const dx = pk.x - bot.x;
        const dy = pk.y - bot.y;
        if (dx * dx + dy * dy > reach * reach) continue;
        pk.dead = true; // remove from the world (authoritative)
        bot.upgrades.collectNormal(pk.typeKey, pk.rarity);
        this.#applyBotStats(bot);
        this.#burst(pk.x, pk.y, RARITY_COLOR[pk.rarity], 8);
      }
    }
  }

  // Resolve a bot's concrete gameplay stats through the SAME authoritative path
  // the player uses: base Standard weapon (GAME.weapons[0]) + player base stats +
  // deriveUpgradeStats. Bots have NO parallel/hidden stat set — a base-level bot
  // with the Standard turret behaves EXACTLY like a base-level player with Standard.
  // Every upgrade the bot collects flows through here into its real gameplay stats.
  #applyBotStats(bot) {
    const w = GAME.weapons[0]; // Standard — the shared player/bot baseline
    const u = deriveUpgradeStats(bot.upgrades.normals);
    const shot0 = w.shots?.[0];

    bot.maxHp = GAME.player.maxHp; // (no HP upgrade type exists) — matches player
    if (bot.hp > bot.maxHp) bot.hp = bot.maxHp;
    bot.turnRate = GAME.player.turnRate;
    bot.accel = GAME.player.accel;
    bot.recoilAmount = w.recoil ?? GAME.player.recoil;
    bot.speed = GAME.player.speed * u.speedMul * (w.moveMul || 1);
    bot.armor = u.armor;
    bot.fireRate = (w.cooldown ?? GAME.player.fireRate) * u.fireRateMul;
    bot._bulletSpeed = (w.bulletSpeed ?? GAME.bullet.speed) * u.bulletSpeedMul;
    bot._bulletLife = (w.bulletLife ?? GAME.bullet.life) * u.bulletLifeMul;
    bot._bulletRadius = w.bulletRadius ?? GAME.bullet.radius;
    bot._bulletDamage = shot0?.damage ?? GAME.bullet.damage;
    bot._armorMul = 1 - (w.armorPen || 0);

    // Build-aware positioning: a bot's preferred engagement distance tracks its
    // ACTUAL projectile reach, so bullet-speed/range upgrades naturally push it to
    // fight from farther (Standard style otherwise). Derived from real stats, not
    // a hardcoded threshold.
    const params = bot.ai?.profile?.params;
    if (params) params.preferredRange = Math.min(560, Math.max(300, bot._bulletSpeed * bot._bulletLife * 0.45));
  }

  #setSwapPrompt(pk) {
    this.swapPrompt = pk;
    this.hud.setPrompt(pk ? "PRESS [F] TO SWAP SPECIAL UPGRADE" : null);
  }

  // Physically eject a replaced special back into the world: it flies out in the
  // player's facing direction and becomes a normal collectible after a short
  // delay (so it isn't instantly re-picked-up).
  #dropSpecial(key) {
    const p = this.player;
    if (!p) return;
    const a = p.rotation;
    const spd = 240;
    const pk = new UpgradePickup({
      x: p.x + Math.cos(a) * (p.radius + 40),
      y: p.y + Math.sin(a) * (p.radius + 40),
      kind: "special",
      typeKey: key,
      vx: Math.cos(a) * spd,
      vy: Math.sin(a) * spd,
      pickupDelay: 0.8,
    });
    this.pickups.push(pk);
    this.engine.addEntity(pk);
    this.#burst(pk.x, pk.y, 0xffd24a, 8);
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
    this.#updateGhosts();
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
    this.#updateGhosts();
  }

  #addPickup(opts) {
    const pk = new UpgradePickup(opts);
    this.pickups.push(pk);
    this.engine.addEntity(pk);
  }

  // --- crates ---------------------------------------------------------------

  // Loot crates per rarity zone. Each holds GAME.crate.items upgrade items
  // (mostly normals, occasional special) rolled from that zone's rarity weights.
  #spawnCrates() {
    let inner = 0;
    ZONES.forEach((zone, zi) => {
      const n = GAME.crate.perZone[zi] || 0;
      for (let i = 0; i < n; i++) {
        const { x, y } = this.#randInRing(inner, zone.maxR);
        const rarity = pickRarity(zone.weights);
        const items = [];
        for (let k = 0; k < GAME.crate.items; k++) {
          if (Math.random() < GAME.crate.specialChance) {
            items.push({ kind: "special", typeKey: SPECIALS[(Math.random() * SPECIALS.length) | 0].key });
          } else {
            items.push({
              kind: "normal",
              typeKey: NORMAL_TYPES[(Math.random() * NORMAL_TYPES.length) | 0].key,
              rarity: pickRarity(zone.weights),
            });
          }
        }
        const crate = new Crate({ x, y, rarity, items });
        this.crates.push(crate);
        this.engine.addEntity(crate);
      }
      inner = zone.maxR;
    });
  }

  // Crates are SHOT open: player OR bot bullets chip a crate's hp; at 0 it bursts
  // and scatters its loot. Guardian shells don't open crates. No contact opening.
  #bulletCrates() {
    for (const b of this.bullets) {
      if (b.dead || b.team === "guardian") continue;
      for (const c of this.crates) {
        if (c.dead) continue;
        const nx = Math.max(c.minX, Math.min(b.x, c.maxX));
        const ny = Math.max(c.minY, Math.min(b.y, c.maxY));
        const dx = b.x - nx;
        const dy = b.y - ny;
        if (dx * dx + dy * dy <= b.radius * b.radius) {
          b.dead = true;
          c.takeDamage(b.damage);
          this.#burst(b.x, b.y, COLORS.crate, 4);
          if (c.hp <= 0) this.#breakCrate(c);
          break;
        }
      }
    }
  }

  // A shot-open crate SCATTERS its loot outward as world pickups — nothing is
  // auto-granted; the player walks over the ones they want to collect them.
  #breakCrate(c) {
    c.dead = true;
    for (const it of c.items) this.#scatterItem(c.x, c.y, it);
    this.#crateBurst(c);
    this.#shakeAt(c.x, c.y, 6);
  }

  // Shake THIS player's camera for a world event at (x, y), scaled by distance from
  // the player: full within `shakeNear`, linear falloff to zero at `shakeFar`, and
  // nothing across the map. Phrased per-player (no global "any death → shake") so a
  // future multiplayer build just asks the same question for each player's camera.
  #shakeAt(x, y, amount) {
    const p = this.player;
    if (!p) return; // no local player → no camera to shake here
    const d = Math.hypot(x - p.x, y - p.y);
    const near = GAME.camera.shakeNear;
    const far = GAME.camera.shakeFar;
    if (d >= far) return;
    const f = d <= near ? 1 : 1 - (d - near) / (far - near);
    const amt = amount * f;
    if (amt > 0.3) this.engine.camera.shake(amt);
  }

  // Eject one crate item as a collectible pickup, flung out with a short delay.
  #scatterItem(x, y, it) {
    const a = Math.random() * Math.PI * 2;
    const spd = 170 + Math.random() * 150;
    const pk = new UpgradePickup({
      x,
      y,
      kind: it.kind,
      typeKey: it.typeKey,
      rarity: it.rarity || 0,
      vx: Math.cos(a) * spd,
      vy: Math.sin(a) * spd,
      pickupDelay: 0.5,
    });
    pk.ghost = this.#isRedundant(pk);
    this.pickups.push(pk);
    this.engine.addEntity(pk);
  }

  // Crate opening: a brown burst plus item-colored shards ejecting outward.
  #crateBurst(c) {
    this.#burst(c.x, c.y, COLORS.crate, 16);
    this.#burst(c.x, c.y, COLORS.crateEdge, 10);
    for (const it of c.items) {
      const color = it.kind === "special" ? 0xffd24a : RARITY_COLOR[it.rarity];
      const a = Math.random() * Math.PI * 2;
      const s = 220 + Math.random() * 160;
      this.engine.addEntity(
        new Particle({ x: c.x, y: c.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, radius: 5, color, life: 0.5 }),
      );
    }
  }

  // --- walls ----------------------------------------------------------------

  // Procedural wall clusters of simple rectangles. Spawning avoids the center
  // (guardians/loot) and the player's outer-ring drop, and uses loose clusters
  // so routes stay open (never fully boxing anyone in).
  #spawnWalls() {
    const cfg = GAME.walls;
    const [pmin, pmax] = cfg.perCluster;
    const [smin, smax] = cfg.size;
    const reach = WORLD.arenaHalf * 0.92;
    let made = 0;
    let guard = 0;
    while (made < cfg.clusters && guard++ < cfg.clusters * 12) {
      // cluster anchor: away from center and the player's drop
      const a = Math.random() * Math.PI * 2;
      const r = cfg.avoidCenter + Math.random() * (reach - cfg.avoidCenter);
      const cx = Math.cos(a) * r;
      const cy = Math.sin(a) * r;
      if (this.player && Math.hypot(cx - this.player.x, cy - this.player.y) < cfg.minPlayerDist) continue;

      const n = pmin + ((Math.random() * (pmax - pmin + 1)) | 0);
      for (let i = 0; i < n; i++) {
        const w = smin + Math.random() * (smax - smin);
        const h = smin + Math.random() * (smax - smin);
        const ox = (Math.random() - 0.5) * smax * 1.4;
        const oy = (Math.random() - 0.5) * smax * 1.4;
        const wall = new Wall({ x: cx + ox, y: cy + oy, w, h });
        this.walls.push(wall);
        this.engine.addEntity(wall);
      }
      made++;
    }
  }

  // Push tanks out of walls (circle-vs-AABB, shortest axis) and kill bullets
  // that hit a wall.
  #resolveWalls() {
    const tanks = this.#targets();
    for (const w of this.walls) {
      for (const t of tanks) {
        const nx = Math.max(w.minX, Math.min(t.x, w.maxX));
        const ny = Math.max(w.minY, Math.min(t.y, w.maxY));
        const dx = t.x - nx;
        const dy = t.y - ny;
        if (dx * dx + dy * dy < t.radius * t.radius) {
          if (dx === 0 && dy === 0) continue; // center inside (rare) — skip
          const d = Math.hypot(dx, dy);
          const push = t.radius - d;
          t.x += (dx / d) * push;
          t.y += (dy / d) * push;
          // bleed the velocity component into the wall so it doesn't stick
          if (Math.abs(dx) > Math.abs(dy)) t.vx = 0;
          else t.vy = 0;
        }
      }
      for (const b of this.bullets) {
        if (b.dead) continue;
        if (b.x >= w.minX && b.x <= w.maxX && b.y >= w.minY && b.y <= w.maxY) {
          b.dead = true;
          this.#burst(b.x, b.y, COLORS.hitSpark, 4);
        }
      }
    }
  }

  // --- cosmetics: trails + kill FX -----------------------------------------

  // Leave a cosmetic trail behind the moving player (light — a couple of marks).
  #emitTrail(dt) {
    const p = this.player;
    if (!p || p.dead) return;
    const def = GAME.trails[this.profile?.trail ?? 0];
    if (!def || def.style === "none") return;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed < 40) return;
    this._trailCd = (this._trailCd || 0) - dt;
    if (this._trailCd > 0) return;
    this._trailCd = 0.05;

    const bx = p.x - Math.cos(p.rotation) * p.radius;
    const by = p.y - Math.sin(p.rotation) * p.radius;

    // True Sparks (FX): a shower of yellow/orange/gray sparks flung outward in
    // varied directions — not a single settling mark.
    if (def.style === "trueSparks") {
      const cols = [0xffd24a, 0xff8a3a, 0x9aa0a6];
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 60 + Math.random() * 140;
        this.engine.addEntity(new Particle({ x: bx, y: by, vx: Math.cos(a) * s, vy: Math.sin(a) * s, radius: 2 + Math.random() * 2, color: cols[(Math.random() * cols.length) | 0], life: 0.28 + Math.random() * 0.22 }));
      }
      return;
    }

    let color = def.color ?? p.color;
    if (def.style === "rainbow") color = HSV[(this._rainbow = (this._rainbow + 1) % HSV.length)];
    const radius = def.style === "squares" ? 5 : def.style === "spark" ? 3 : def.style === "hologram" ? 6 : 7;
    this.engine.addEntity(
      new Particle({ x: bx, y: by, vx: 0, vy: 0, radius, color, life: def.style === "smoke" ? 0.6 : def.style === "hologram" ? 0.5 : 0.4 }),
    );
  }

  // Spawn the equipped kill FX at a defeated tank (player kills only).
  #killEffect(x, y, color) {
    const fx = GAME.killFx[this.profile?.killFx ?? 0]?.fx || "none";
    if (fx === "none") return; // "No Kill FX" — the default
    if (fx === "stars") {
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const s = 200;
        this.engine.addEntity(new Particle({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, radius: 4, color: 0xffd24a, life: 0.6 }));
      }
    } else if (fx === "explosion") {
      this.#burst(x, y, 0xffa53a, 22);
      this.#burst(x, y, 0xe2564b, 14);
      this.engine.camera.shake(8);
    } else if (fx === "dissolve") {
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 30 + Math.random() * 60;
        this.engine.addEntity(new Particle({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, radius: 3, color, life: 0.8 }));
      }
    } else {
      this.#burst(x, y, color, 16); // burst (default)
    }
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
      gradient: gradOf(c),
      turret: this.weapon?.turret || "single",
      wrap: (GAME.wraps[this.profile.wrap] || GAME.wraps[0]).pattern,
    });
    this.player.team = "player";
    this.engine.addEntity(this.player);
    this.engine.camera.follow(this.player);

    // Title above the name: "[TITLE]" (in its color) over a WHITE nametag. "No
    // Title" hides it; FX titles are bold, others normal weight.
    const title = GAME.titles[this.profile.title] || GAME.titles[0];
    this.titleLabel = new Text({
      text: title.none ? "" : `[${title.name}]`,
      style: { fill: title.color ?? COLORS.xpFill, fontFamily: "Ubuntu, Arial", fontSize: 12, fontWeight: title.bold ? "bold" : "normal", stroke: NAME_STROKE },
    });
    this.titleLabel.visible = !title.none;
    this.titleLabel.anchor.set(0.5);
    this.titleLabel.position.set(0, this.player.radius + 16);
    this.nameLabel = new Text({
      text: this.profile.displayName,
      style: { fill: 0xffffff, fontFamily: "Ubuntu, Arial", fontSize: 13, fontWeight: "bold", stroke: NAME_STROKE },
    });
    this.nameLabel.anchor.set(0.5);
    this.nameLabel.position.set(0, this.player.radius + 33);
    this.player.view.addChild(this.titleLabel, this.nameLabel);

    this.#applyStats();
  }

  #spawnBot() {
    // Every bot is a Standard-turret tank on the PLAYER's base stats (turret
    // "single", GAME.player.* defaults). Concrete combat stats are resolved by
    // #applyBotStats below — no GAME.bot combat values, so no hidden modifiers.
    const bot = new Tank({ input: null, camera: null, bounds: this.bounds, turret: "single" });
    this.#placeInArena(bot, 360);
    // Each bot gets its OWN team so bots can damage each other (BR matches now
    // produce natural bot-vs-bot combat, not just bot-vs-player).
    bot.team = "bot" + this._botSeq++;
    // Use an evolved policy if the offline trainer has saved any (labelled by
    // skill tier); otherwise a fresh random genome.
    bot.ai = new BotBrain(this, pickSavedPolicy());
    // All bots wield Standard for now, so they all use the Standard positioning
    // style (close-in "poke"); personality/skill still vary. preferredRange is then
    // set from actual stats in #applyBotStats.
    bot.ai.profile.style = STANDARD_STYLE;
    bot.ai.profile.styleName = STANDARD_STYLE.name;
    bot.upgrades = new UpgradeState(); // bots collect the same world pickups the player does
    this.#applyBotStats(bot); // resolve Standard + player base + (empty) upgrades → real stats
    bot.level = tierIndex(bot.ai.skill) + 1; // derive the old 1..N level from skill tier
    bot.name = this._nameGen(); // unique callsign per lobby (no more "BOT")
    this.#addLabel(bot, bot.name, ENEMY_NAME); // enemies: light red nametag
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
      this.#addLabel(gd, "GUARDIAN", 0xb23a3a);
      this.guardians.push(gd);
      this.engine.addEntity(gd);
    }
  }

  #addLabel(tank, text, fill) {
    const label = new Text({
      text,
      style: { fill, fontFamily: "Ubuntu, Arial", fontSize: 12, fontWeight: "bold", stroke: NAME_STROKE },
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
    this.crates = [];
    this.walls = [];
    this.sentryDrone = null;
    this.lootDrone = null;
    this.swapPrompt = null;
    this.hud.setPrompt(null);
    this._botSeq = 0;
    this._nameGen = makeNameGen();
    this._playerHitCd = 0;
    this._flashCd = 0;
    this._salvo = [];
    this._rockets = [];
    this._laserTick = 0;
    this._laserHeat = 0;
    this._laserLocked = 0;
    this._laserInterrupt = 0;
    this._firedLaser = false;
    this._laserBeam?.clear();
    this.engine.camera.zoom = 1;
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

  #spawnBullet({ x, y, angle }, team, owner = null) {
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
      // Bots: damage, speed + life all come from the bot's authoritative resolved
      // stats (Standard base × upgrades), NOT a separate bot stat block.
      speed = owner?._bulletSpeed ?? GAME.bullet.speed;
      damage = owner?._bulletDamage ?? GAME.bullet.damage;
      life = owner?._bulletLife ?? GAME.bullet.life;
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
    b.owner = owner || (team === "player" ? this.player : null); // firing tank, for kill attribution
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
