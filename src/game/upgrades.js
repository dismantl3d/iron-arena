// Data + helpers for the in-match upgrade system (collected as world pickups,
// not bought in a menu). Pure data — no rendering or game state here.
//
// The authoritative stat-resolution (RARITY_MUL + deriveUpgradeStats) moved into
// the renderer-free simulation layer (src/sim/upgradeStats.js) in Phase 14.2 Step 3;
// it's re-exported here so existing importers keep working unchanged.

import { WORLD } from "../config.js";
// Pure re-export (not import-then-export — that trips Vite's dev transform into a
// duplicate declaration). upgrades.js doesn't use these internally.
export { RARITY_MUL, deriveUpgradeStats } from "../sim/upgradeStats.js";

// Rarity ladder, low -> high. Index into this is a pickup's "rarity".
export const RARITIES = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];
export const RARITY_COLOR = [0x9aa0b0, 0x76d672, 0x4aa3ff, 0xc26cff, 0xffd24a];

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

// (deriveUpgradeStats now lives in src/sim/upgradeStats.js — re-exported above.)
