// Extensible, DATA-DRIVEN weapon firing — the single shared interpreter of a
// weapon's config (GAME.weapons entry). Given the weapon, an entity's resolved
// stats, and an origin, it produces the projectiles to spawn. Pure: no Pixi, no
// world state. Both the server WorldModel and the client Game fire through this,
// so a NEW weapon defined via the established config schema (shots[] / burst /
// rocket) is automatically multiplayer-compatible — no networking or per-weapon MP
// code is needed. Only a genuinely-new *mechanic* (e.g. a new fireMode) adds a
// handler HERE, inside the shared simulation, never in the networking layer.
//
// Config schema (unchanged, authoritative source of behavior):
//   weapon: { cooldown, recoil, bulletSpeed, bulletRadius, bulletLife, spread,
//             muzzle?, fireMode?, pierce?, armorPen?,
//             shots: [{ perp?, angle?, damage, speedMul?, radiusMul?, delay?, muzzle? }],
//             burst?: { count, interval },
//             rocket?: {...}, laser?: {...} }
//   stats:  { bulletSpeed, bulletRadius, bulletLife, bulletDamage, armorMul }  (upgrade-resolved)
//   origin: { x, y, rot, radius }

// One shot spec -> a concrete projectile descriptor (position, velocity, stats).
// Mirrors Game.#spawnShot exactly (same muzzle/perp/spread math).
export function shotToProjectile(s, weapon, stats, origin) {
  const w = weapon;
  const baseAng = origin.rot + (s.angle || 0);
  const fireAng = baseAng + (Math.random() - 0.5) * (w.spread || 0);
  const md = s.muzzle ?? w.muzzle ?? origin.radius * 2.2;
  const perpX = -Math.sin(baseAng);
  const perpY = Math.cos(baseAng);
  const x = origin.x + Math.cos(baseAng) * md + perpX * (s.perp || 0);
  const y = origin.y + Math.sin(baseAng) * md + perpY * (s.perp || 0);
  const speed = stats.bulletSpeed * (s.speedMul || 1);
  return {
    x, y, angle: fireAng,
    vx: Math.cos(fireAng) * speed,
    vy: Math.sin(fireAng) * speed,
    speed,
    damage: s.damage ?? stats.bulletDamage,
    radius: stats.bulletRadius * (s.radiusMul || 1),
    life: stats.bulletLife,
    armorMul: stats.armorMul ?? 1,
    pierce: w.pierce || 0,
    knockback: 0,
    shape: "circle",
    isRocket: false,
  };
}

// One trigger pull -> the projectiles to spawn now (`immediate`) and later
// (`salvo`, each { t: seconds, shot }). Covers the default multi-barrel weapons
// (shots[] with per-shot delay for staggering) AND the 3-round burst. Mirrors
// Game.#firePlayer's shots/burst branch.
export function resolveShots(weapon, stats, origin) {
  const w = weapon;
  const shots = w.shots && w.shots.length ? w.shots : [{ damage: stats.bulletDamage }];
  const immediate = [];
  const salvo = [];

  if (w.fireMode === "burst" && w.burst) {
    const base = shots[0];
    for (let i = 0; i < w.burst.count; i++) {
      if (i === 0) immediate.push(shotToProjectile(base, w, stats, origin));
      else salvo.push({ t: i * w.burst.interval, shot: base });
    }
  } else {
    for (const s of shots) {
      if (s.delay > 0) salvo.push({ t: s.delay, shot: s });
      else immediate.push(shotToProjectile(s, w, stats, origin));
    }
  }
  return { immediate, salvo };
}

// The Rocketeer's slow, detonatable rocket (fireMode "rocket"). Returns one rocket
// projectile descriptor; its rear-trail bullets + SHIFT detonation are ongoing
// behaviours handled by the simulation each step (see WorldModel / Game), driven by
// the same `weapon.rocket` config.
export function rocketProjectile(weapon, origin) {
  const r = weapon.rocket;
  const md = weapon.muzzle ?? origin.radius * 2.2;
  const x = origin.x + Math.cos(origin.rot) * md;
  const y = origin.y + Math.sin(origin.rot) * md;
  return {
    x, y, angle: origin.rot,
    vx: Math.cos(origin.rot) * r.speed,
    vy: Math.sin(origin.rot) * r.speed,
    speed: r.speed,
    damage: r.damage,
    radius: r.radius,
    life: r.life,
    armorMul: 1,
    pierce: 0,
    knockback: 0,
    shape: "arrow",
    isRocket: true,
  };
}

// What a weapon does when fired: "shots" (projectiles), "rocket", or "laser" (beam).
export function fireModeOf(weapon) {
  return weapon.fireMode || "shots";
}
