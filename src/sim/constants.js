// Authoritative simulation constants — the single source of truth for the headless
// world model (src/sim/WorldModel.js), resolved from the real game config so the
// server and any future client-side sim agree with GAME. No rendering here.
//
// Phase 1 scope: the Standard turret + player base movement. Per-weapon and
// per-upgrade resolution (deriveUpgradeStats) is layered in later phases — the
// world model already keys firing off each entity's own resolved stats where set.

import { GAME } from "../config.js";

const STD = GAME.weapons[0]; // Standard turret

export const SIM = {
  arena: 1400, // arena half-extent (world units) — square [-arena, +arena]
  radius: 28, // tank collision radius (matches Tank default)

  // movement (player base — bots share these in Phase 1)
  speed: GAME.player.speed,
  accel: GAME.player.accel,
  maxHp: GAME.player.maxHp,

  // Standard-turret firing + projectile
  cooldown: STD.cooldown,
  bulletSpeed: STD.bulletSpeed,
  bulletLife: STD.bulletLife,
  bulletRadius: GAME.bullet.radius,
  damage: STD.shots?.[0]?.damage ?? 15,
  barrel: 28 * 2.2, // muzzle distance from center (matches the Tank barrel length)
};
