// Pure gameplay physics — the movement/projectile/collision math shared by the
// authoritative world model (and, today, the server). No Pixi, no DOM, no config
// coupling: every function takes plain numbers/records so it can run anywhere and
// be unit-tested trivially. This is the logic that was previously duplicated inline
// in Game.js and server/index.js.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Is `v` a finite number? (used to sanitize client-provided input).
export const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

// Ease an entity's velocity toward a desired move vector * speed, advance its
// position, then clamp inside `bounds` (a {minX,minY,maxX,maxY} box, or null for
// no clamp). Mutates `e.vx/vy/x/y` in place. This is the ONE movement integrator
// shared by the client `Tank` (which passes its own move dir + speed×moveScale)
// and the headless `WorldModel` (which passes each entity's input axis).
export function integrateMovement(e, dt, mx, my, speed, accel, bounds, radius) {
  const k = 1 - Math.exp(-accel * dt);
  e.vx += (mx * speed - e.vx) * k;
  e.vy += (my * speed - e.vy) * k;
  e.x += e.vx * dt;
  e.y += e.vy * dt;
  if (bounds) {
    e.x = clamp(e.x, bounds.minX + radius, bounds.maxX - radius);
    e.y = clamp(e.y, bounds.minY + radius, bounds.maxY - radius);
  }
}

// The muzzle point of an entity firing along `rot`, `barrel` units from center.
export function muzzle(x, y, rot, barrel) {
  return { x: x + Math.cos(rot) * barrel, y: y + Math.sin(rot) * barrel };
}

// Advance a projectile and age it. Mutates in place.
export function stepBullet(b, dt) {
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.life -= dt;
}

// Circle-vs-circle overlap test.
export function circleOverlap(ax, ay, ar, bx, by, br) {
  const dx = ax - bx;
  const dy = ay - by;
  const r = ar + br;
  return dx * dx + dy * dy <= r * r;
}

// Clamp a raw client move-axis to the unit disc (anti-cheat: no super-speed).
export function clampAxis(mx, my) {
  mx = clamp(num(mx), -1, 1);
  my = clamp(num(my), -1, 1);
  const m2 = mx * mx + my * my;
  if (m2 > 1) {
    const inv = 1 / Math.sqrt(m2);
    mx *= inv;
    my *= inv;
  }
  return { mx, my };
}
