// Headless proof that ALL current weapons fire correctly through the data-driven
// WorldModel weapon system (src/sim/weapons.js) — no per-weapon MP code. For each
// weapon: equip it, fire at a dummy target, and report the resulting authoritative
// projectiles (count/shapes) + whether the target takes damage.  node this file.

import { WorldModel } from "./WorldModel.js";
import { GAME } from "../config.js";

function testWeapon(weaponIndex) {
  const w = GAME.weapons[weaponIndex];
  const world = new WorldModel({ fog: true });
  const A = world.addEntity({ id: "A", type: "player", team: "A", weapon: weaponIndex, x: -120, y: 0 });
  world.resolveStats("A");
  const B = world.addEntity({ id: "B", type: "player", team: "B", weapon: 0, x: 120, y: 0 });

  const shapes = new Set();
  let peakBullets = 0, hitB = false, laserBeam = false, detonated = false, trails = 0;
  const bHp0 = B.hp;
  for (let f = 0; f < 90; f++) {
    B.x = 120; B.y = 0; B.hp = B.maxHp; // pin + heal the dummy so we measure per-hit
    // aim A at B, hold fire; SHIFT-detonate the rocket midway
    world.setInput("A", { mx: 0, my: 0, aim: 0, fire: true, detonate: w.fireMode === "rocket" && f === 40 });
    world.step(1 / 30);
    peakBullets = Math.max(peakBullets, world.bullets.length);
    for (const b of world.bullets) { shapes.add(b.shape); if (b.shape === "star") detonated = true; }
    if (world.bullets.some((b) => !b.isRocket && b.shape === "circle" && b.owner === "A" && Math.abs(b.y) < 5 && b.x < 0)) trails++;
    if (B.hp < bHp0) hitB = true;
    if (A.beam) laserBeam = true;
  }
  return {
    weapon: w.name,
    fireMode: w.fireMode || "shots",
    peak_bullets: peakBullets,
    shapes: [...shapes],
    target_took_damage: hitB,
    ...(w.fireMode === "laser" ? { laser_beam_cast: laserBeam, A_heat: Math.round((A.heat || 0) * 100) / 100 } : {}),
    ...(w.fireMode === "rocket" ? { rocket_detonated_into_pellets: detonated } : {}),
  };
}

const out = GAME.weapons.map((_, i) => testWeapon(i));
console.log(JSON.stringify(out, null, 2));
