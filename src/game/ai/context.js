// The bot decision CONTEXT: a snapshot of the game state a bot reasons about.
// Built on the throttled plan tick (NOT every frame) so 100 bots stay cheap. It
// only uses information a human player would also have (nearby entities within a
// skill-scaled awareness radius — no omniscience).

import { GAME } from "../../config.js";
import { pickBestLoot } from "./loot.js";

// Whether a bot can actually USE this pickup: it only collects NORMAL stat
// upgrades it doesn't already own at an equal/higher rarity. Specials are left
// for the player. Prevents bots sitting on upgrades they can't use.
export function botCanUse(pk, tank) {
  if (pk.kind !== "normal") return false;
  const owned = tank.upgrades?.normals?.[pk.typeKey];
  return owned === undefined || pk.rarity > owned;
}

// The most imminent enemy bullet heading at this tank, with a perpendicular dodge
// direction — or null. Only considers NEARBY bullets (perception, not global).
// Exported so the executor can refresh it per-frame for bots in combat.
export function detectIncoming(game, tank) {
  const bullets = game.bullets;
  if (!bullets || !bullets.length) return null;
  let best = null;
  let bestT = Infinity;
  let count = 0; // how many distinct bullets are threatening at once (multi-threat)
  const R2 = 520 * 520;
  for (const b of bullets) {
    if (b.dead || b.team === tank.team) continue;
    const relx = tank.x - b.x;
    const rely = tank.y - b.y;
    if (relx * relx + rely * rely > R2) continue; // too far to notice
    const v2 = b.vx * b.vx + b.vy * b.vy;
    if (v2 < 1) continue;
    const t = (relx * b.vx + rely * b.vy) / v2; // time to closest approach
    if (t <= 0 || t > 0.6) continue; // moving away, or too far off in the future
    const cx = b.x + b.vx * t;
    const cy = b.y + b.vy * t;
    const mdx = tank.x - cx;
    const mdy = tank.y - cy;
    const hitR = tank.radius + (b.radius || 6) + 8;
    const miss2 = mdx * mdx + mdy * mdy;
    if (miss2 > (hitR * 1.6) * (hitR * 1.6)) continue; // clearly going to miss
    if (miss2 <= hitR * hitR) count++; // on a real collision course
    if (t < bestT && miss2 <= hitR * hitR) {
      bestT = t;
      const inv = 1 / Math.sqrt(v2);
      const px = -b.vy * inv;
      const py = b.vx * inv; // perpendicular to bullet travel
      const side = mdx * px + mdy * py < 0 ? -1 : 1; // dodge to the side we're already offset
      best = { dodgeX: px * side, dodgeY: py * side, time: t };
    }
  }
  if (best) best.count = count;
  return best;
}

// perceive(game, tank, profile) -> context object (see fields at the bottom).
export function perceive(game, tank, profile) {
  // Skill only slightly widens perception — beginners still detect enemies from a
  // reasonable distance (no artificial blindness), skilled bots see a bit more.
  const aware = GAME.ai.awareness * (0.85 + profile.skill * 0.4);
  const a2 = aware * aware;

  // Enemy candidates = the player + OTHER bots (each bot has its own team, so
  // bots are enemies to each other). Guardians are handled separately below.
  const enemies = [];
  const consider = (t) => {
    if (!t || t.dead || t === tank || t.team === tank.team) return;
    const dx = t.x - tank.x;
    const dy = t.y - tank.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= a2) enemies.push({ tank: t, dist: Math.sqrt(d2) });
  };
  consider(game.player);
  for (const b of game.bots) consider(b);
  enemies.sort((p, q) => p.dist - q.dist);
  if (enemies.length > 5) enemies.length = 5; // cap candidate set for cost

  // Nearest Arena Guardian.
  let guardian = null;
  let gd2 = a2;
  for (const g of game.guardians) {
    if (g.dead) continue;
    const dx = g.x - tank.x;
    const dy = g.y - tank.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= gd2) {
      gd2 = d2;
      guardian = g;
    }
  }

  // Best-VALUE loot (not merely the nearest): the crate/usable pickup worth the
  // most to this bot's build, discounted by distance + nearby-enemy risk.
  const bestLoot = pickBestLoot(game, tank, profile, aware);
  const loot = bestLoot?.loot ?? null;
  const lootKind = bestLoot?.kind ?? null;

  // Incoming projectiles the bot can perceive (for dodging): the most imminent
  // enemy bullet on a near-collision course. Perception-limited (nearby only).
  const incoming = detectIncoming(game, tank);

  const distCenter = Math.hypot(tank.x, tank.y);
  const fog = game.fog;
  const safeR = Math.min(fog.radius, fog.nextRadius ?? fog.radius);
  const alive = game.bots.length + (game.player && !game.player.dead ? 1 : 0);

  return {
    hp: tank.hp,
    maxHp: tank.maxHp,
    hpFrac: tank.hp / tank.maxHp,
    underFire: tank._hitTimer > 0, // took damage very recently -> actively threatened
    x: tank.x,
    y: tank.y,
    distCenter,
    enemies,
    enemy: enemies[0]?.tank ?? null,
    enemyDist: enemies[0]?.dist ?? Infinity,
    guardian,
    guardianDist: guardian ? Math.sqrt(gd2) : Infinity,
    guardianHpFrac: guardian ? guardian.hp / guardian.maxHp : 1,
    loot,
    lootKind,
    lootDist: bestLoot?.dist ?? Infinity,
    lootValue: bestLoot?.value ?? 0, // build-aware usefulness of the chosen loot
    lootScore: bestLoot?.score ?? 0, // value discounted by distance + risk
    incoming, // { dodgeX, dodgeY, time } or null — perceived incoming projectile
    fogR: fog.radius,
    fogNext: fog.nextRadius ?? fog.radius,
    outside: fog.isOutside(tank.x, tank.y),
    distToSafe: Math.max(0, distCenter - safeR),
    safeR,
    alive,
    phase: alive > 20 ? "early" : alive > 8 ? "mid" : "late",
  };
}
