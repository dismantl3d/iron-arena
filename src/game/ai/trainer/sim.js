// Headless Battle-Royale simulation for OFFLINE evolutionary training. It reuses
// the REAL bot AI (BotBrain + context/targeting/objectives) against a lightweight,
// Pixi-free world, so evolving the genome optimises the ACTUAL in-game behaviour.
// No rendering, no DOM — pure numbers. Runs a compact arena with shrinking fog so
// matches resolve quickly and produce a clear fitness signal.

import { GAME } from "../../../config.js";
import { approachAngle } from "../../../utils/angle.js";
import { BotBrain } from "../../BotBrain.js";
import { UpgradeState } from "../../UpgradeState.js";
import { deriveUpgradeStats, NORMAL_TYPES } from "../../upgrades.js";
import { botCanUse } from "../context.js";

const ARENA = 1600; // compact training arena (half-extent) so bots actually meet
const DT = 0.05; // fixed sim step (20 Hz — plenty for AI decisions)
const STD = GAME.weapons[0]; // Standard weapon — bots share the player baseline

// One tank in the sim. `policyIndex` links it back to the population entry.
function makeSimTank(world, genome, policyIndex, teamId) {
  const a = Math.random() * Math.PI * 2;
  const r = ARENA * (0.35 + Math.random() * 0.6);
  const tank = {
    x: Math.cos(a) * r,
    y: Math.sin(a) * r,
    rotation: Math.random() * Math.PI * 2,
    hp: GAME.player.maxHp,
    maxHp: GAME.player.maxHp,
    team: "t" + teamId,
    radius: 28,
    vx: 0,
    vy: 0,
    moveScale: 1,
    speed: GAME.player.speed,
    turnRate: GAME.player.turnRate,
    fireRate: STD.cooldown,
    _bulletSpeed: STD.bulletSpeed,
    _bulletLife: STD.bulletLife,
    _bulletDamage: STD.shots[0].damage,
    _fireTimer: Math.random() * 0.5,
    _hitTimer: 0,
    accel: GAME.player.accel,
    dead: false,
    bounds: { minX: -ARENA, minY: -ARENA, maxX: ARENA, maxY: ARENA },
    upgrades: new UpgradeState(),
    policyIndex,
    stats: { damageDealt: 0, damageTaken: 0, kills: 0, survival: 0, upgrades: 0, placement: 0 },
    takeDamage(amt, armorMul = 1) {
      const armor = Math.min(0.9, (this.armor || 0) * armorMul);
      const dealt = amt * (1 - armor);
      this.hp = Math.max(0, this.hp - dealt);
      this._hitTimer = 1.5;
      this.stats.damageTaken += dealt;
      return dealt;
    },
  };
  tank.ai = new BotBrain(world, genome);
  return tank;
}

// Run one match between `genomes` (array). Returns per-genome stats (aligned to
// the input order): { placement, survival, damageDealt, damageTaken, kills, upgrades }.
export function runMatch(genomes, opts = {}) {
  const maxTime = opts.maxTime ?? 70;
  const world = {
    phase: "playing",
    player: null,
    guardians: [],
    crates: [],
    bots: [],
    pickups: [],
    bullets: [],
    fog: {
      radius: ARENA * 1.3,
      nextRadius: ARENA * 0.7,
      isOutside(x, y) {
        return x * x + y * y > this.radius * this.radius;
      },
    },
  };

  world.bots = genomes.map((g, i) => makeSimTank(world, g, i, i));
  // Scatter a handful of upgrade pickups to reward loot behaviour.
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * ARENA * 0.9;
    world.pickups.push({
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      kind: "normal",
      typeKey: NORMAL_TYPES[(Math.random() * NORMAL_TYPES.length) | 0].key,
      rarity: (Math.random() * 3) | 0,
      radius: 22,
      ghost: false,
      dead: false,
    });
  }

  const results = genomes.map(() => null);
  const fogFinal = 260;
  const shrinkPer = (world.fog.radius - fogFinal) / (maxTime * 0.85);
  let alive = world.bots.length;
  let t = 0;

  const finish = (tank, placement) => {
    tank.dead = true;
    tank.stats.placement = placement;
    results[tank.policyIndex] = { ...tank.stats };
  };

  while (t < maxTime && alive > 1) {
    t += DT;
    // fog shrink
    world.fog.radius = Math.max(fogFinal, world.fog.radius - shrinkPer * DT);
    world.fog.nextRadius = Math.max(fogFinal, world.fog.radius - 120);

    // --- AI + movement + firing ---
    for (const tank of world.bots) {
      if (tank.dead) continue;
      tank.stats.survival = t;
      const derived = deriveUpgradeStats(tank.upgrades.normals);
      tank.speed = GAME.player.speed * derived.speedMul;
      tank.fireRate = STD.cooldown * derived.fireRateMul;
      tank.armor = derived.armor;
      tank._bulletSpeed = STD.bulletSpeed * derived.bulletSpeedMul;
      tank._bulletLife = STD.bulletLife * derived.bulletLifeMul;

      const cmd = tank.ai.think(DT, tank);
      const k = 1 - Math.exp(-tank.accel * DT);
      const spd = tank.speed * (tank.moveScale || 1);
      tank.vx += (cmd.move.x * spd - tank.vx) * k;
      tank.vy += (cmd.move.y * spd - tank.vy) * k;
      tank.x += tank.vx * DT;
      tank.y += tank.vy * DT;
      const b = tank.bounds;
      tank.x = Math.min(Math.max(tank.x, b.minX + tank.radius), b.maxX - tank.radius);
      tank.y = Math.min(Math.max(tank.y, b.minY + tank.radius), b.maxY - tank.radius);
      tank.rotation = approachAngle(tank.rotation, cmd.aim, tank.turnRate * DT);
      if (tank._fireTimer > 0) tank._fireTimer -= DT;
      if (tank._hitTimer > 0) tank._hitTimer -= DT;

      if (tank.ai.wantsFire && tank._fireTimer <= 0) {
        tank._fireTimer = tank.fireRate;
        const md = tank.radius * 2.2;
        world.bullets.push({
          x: tank.x + Math.cos(tank.rotation) * md,
          y: tank.y + Math.sin(tank.rotation) * md,
          vx: Math.cos(tank.rotation) * tank._bulletSpeed,
          vy: Math.sin(tank.rotation) * tank._bulletSpeed,
          radius: GAME.bullet.radius,
          damage: tank._bulletDamage,
          life: tank._bulletLife,
          team: tank.team,
          owner: tank,
          dead: false,
        });
      }
    }

    // --- bullets ---
    for (const bl of world.bullets) {
      if (bl.dead) continue;
      bl.x += bl.vx * DT;
      bl.y += bl.vy * DT;
      bl.life -= DT;
      if (bl.life <= 0 || Math.abs(bl.x) > ARENA || Math.abs(bl.y) > ARENA) {
        bl.dead = true;
        continue;
      }
      for (const tank of world.bots) {
        if (tank.dead || tank.team === bl.team) continue;
        const dx = tank.x - bl.x;
        const dy = tank.y - bl.y;
        const reach = tank.radius + bl.radius;
        if (dx * dx + dy * dy <= reach * reach) {
          const dealt = tank.takeDamage(bl.damage);
          if (bl.owner && !bl.owner.dead) bl.owner.stats.damageDealt += dealt;
          bl.dead = true;
          if (tank.hp <= 0) {
            if (bl.owner) bl.owner.stats.kills++;
            finish(tank, alive);
            alive--;
          }
          break;
        }
      }
    }
    world.bullets = world.bullets.filter((b) => !b.dead);

    // --- fog damage ---
    for (const tank of world.bots) {
      if (tank.dead) continue;
      if (world.fog.isOutside(tank.x, tank.y)) {
        tank.hp -= GAME.fog.dps * DT;
        if (tank.hp <= 0) {
          finish(tank, alive);
          alive--;
        }
      }
    }

    // --- loot pickup (same authoritative rule as the live game) ---
    for (const tank of world.bots) {
      if (tank.dead) continue;
      const loot = tank.ai?.ctx?.loot;
      if (!loot || loot.dead || !botCanUse(loot, tank)) continue;
      const reach = tank.radius + loot.radius;
      if ((loot.x - tank.x) ** 2 + (loot.y - tank.y) ** 2 <= reach * reach) {
        loot.dead = true;
        tank.upgrades.collectNormal(loot.typeKey, loot.rarity);
        tank.stats.upgrades++;
      }
    }
    world.pickups = world.pickups.filter((p) => !p.dead);
  }

  // Whoever's left standing gets the top placements.
  const survivors = world.bots.filter((t) => !t.dead).sort((a, b) => b.hp - a.hp);
  survivors.forEach((tank, i) => {
    tank.stats.placement = i + 1;
    results[tank.policyIndex] = { ...tank.stats };
  });
  // Fill any gaps (shouldn't happen, but be safe).
  for (const tank of world.bots) if (!results[tank.policyIndex]) results[tank.policyIndex] = { ...tank.stats };
  return results;
}
