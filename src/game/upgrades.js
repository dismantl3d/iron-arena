// Data + helpers for the in-match upgrade system (collected as world pickups,
// not bought in a menu). Pure data — no rendering or game state here.

import { WORLD } from "../config.js";

// Rarity ladder, low -> high. Index into this is a pickup's "rarity".
export const RARITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];
export const RARITY_COLOR = [0x9aa0b0, 0x76d672, 0x4aa3ff, 0xc26cff, 0xffd24a];
// Effect scale per rarity (how strong a collected upgrade is).
export const RARITY_MUL = [1, 1.6, 2.3, 3.2, 4.5];

// Normal upgrade types. `key` is used everywhere; `name`/`effect` feed tooltips.
export const NORMAL_TYPES = [
  { key: "bulletSpeed", name: "Bullet Speed", effect: "Faster projectiles" },
  { key: "bulletRange", name: "Bullet Range", effect: "Projectiles travel farther" },
  { key: "reloadSpeed", name: "Reload Speed", effect: "Shoot more often" },
  { key: "tankArmor", name: "Tank Armor", effect: "Reduce incoming damage" },
  { key: "moveSpeed", name: "Movement Speed", effect: "Move faster" },
];

// Special upgrades (framework only — max 2 equipped, collecting a 3rd replaces
// the oldest). Effects are intentionally light.
export const SPECIALS = [
  { key: "healing", name: "Healing", effect: "Regenerate health over time" },
  { key: "flash", name: "Flash", effect: "Dash a short distance (Space)" },
  { key: "loot", name: "Loot Drone", effect: "Widens pickup collection range" },
  { key: "sentry", name: "Sentry Drone", effect: "Drone fires at nearby enemies" },
  { key: "radar", name: "Radar", effect: "Reveals the battlefield" },
];

// Concentric rarity zones (by distance from arena center). Each zone has a
// rarity weight distribution [common..legendary], a pickup count, and a number
// of special pickups. The center is guaranteed at least one special.
const H = WORLD.arenaHalf;
export const ZONES = [
  { name: "center", maxR: H * 0.16, weights: [0, 0, 0, 0.8, 0.2], pickups: 5, specials: 2 },
  { name: "middle", maxR: H * 0.4, weights: [0, 0, 0.45, 0.45, 0.1], pickups: 9, specials: 1 },
  { name: "inner", maxR: H * 0.68, weights: [0, 0.45, 0.4, 0.15, 0], pickups: 13, specials: 0 },
  { name: "outside", maxR: H, weights: [0.5, 0.35, 0.15, 0, 0], pickups: 18, specials: 0 },
];

// Pick a rarity index from a zone's weight distribution.
export function pickRarity(weights) {
  let r = Math.random();
  for (let i = 0; i < weights.length; i++) {
    if (r < weights[i]) return i;
    r -= weights[i];
  }
  return weights.length - 1;
}

// Turn the player's collected normal upgrades { typeKey: rarityIndex } into
// concrete stat multipliers applied on top of base stats.
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
