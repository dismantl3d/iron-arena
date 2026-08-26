// Authoritative upgrade → effective-stats resolution — renderer-free (moved here
// from src/game as part of Phase 14.2 Step 3). Given a weapon config + an entity's
// collected normal upgrades, this produces the concrete combat numbers the sim
// uses. This is the SAME math the client's Game.#applyStats/#applyBotStats used;
// it's just now owned by the simulation layer so the server/world model can resolve
// entity stats identically. NO new upgrade types, NO rebalancing.

import { GAME } from "../config.js";

// Effect scale per rarity (Common → Legendary).
export const RARITY_MUL = [1, 1.6, 2.3, 3.2, 4.5];

// Collected normals { typeKey: rarityIndex } → stat multipliers over base stats.
export function deriveUpgradeStats(normals) {
  const mul = (key) => (key in normals ? RARITY_MUL[normals[key]] : 0);
  return {
    bulletSpeedMul: 1 + 0.12 * mul("bulletSpeed"),
    bulletLifeMul: 1 + 0.15 * mul("bulletRange"),
    fireRateMul: 1 / (1 + 0.1 * mul("reloadSpeed")), // smaller interval = faster
    armor: Math.min(0.6, 0.08 * mul("tankArmor")), // fraction of damage blocked
    speedMul: 1 + 0.07 * mul("moveSpeed"),
  };
}

// Resolve an entity's concrete effective stats from its weapon (a GAME.weapons
// entry) + collected normal upgrades. Returns plain numbers; callers assign them
// to their entity (client Tank fields, or world-model entity records). Laser is
// resolved when the weapon's fireMode is "laser" (its Bullet-Speed/Reload pickups
// re-purpose as Laser Damage / Lethality). Mirrors the old Game.#applyStats exactly.
export function resolveEntityStats(weapon, normals) {
  const w = weapon || {};
  const u = deriveUpgradeStats(normals);
  const shot0 = w.shots?.[0];

  const stats = {
    speed: GAME.player.speed * u.speedMul * (w.moveMul || 1),
    armor: u.armor,
    recoilAmount: w.recoil ?? GAME.player.recoil,
    fireRate: (w.cooldown ?? GAME.player.fireRate) * u.fireRateMul,
    bulletSpeed: (w.bulletSpeed ?? GAME.bullet.speed) * u.bulletSpeedMul,
    bulletLife: (w.bulletLife ?? GAME.bullet.life) * u.bulletLifeMul,
    bulletRadius: w.bulletRadius ?? GAME.bullet.radius,
    bulletDamage: shot0?.damage ?? GAME.bullet.damage,
    armorMul: 1 - (w.armorPen || 0), // < 1 pierces armor
    laser: null,
  };

  if (w.fireMode === "laser") {
    const raw = (key) => (key in normals ? RARITY_MUL[normals[key]] : 0);
    const L = w.laser;
    stats.laser = {
      tickDamage: L.tickDamage + 1 * raw("bulletSpeed"), // +1 dmg/tick per level
      tickRate: L.tickRate * Math.max(0.4, 1 - 0.05 * raw("reloadSpeed")), // faster ticks
    };
  }
  return stats;
}
