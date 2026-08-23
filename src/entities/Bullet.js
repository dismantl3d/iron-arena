// A bullet travels in a straight line from the moment it spawns, independent of
// the tank that fired it. It dies when its lifetime runs out or it leaves the
// arena; the Game also kills it on collision. Cleanup is handled by the Engine
// once `dead` is set.
//
// `shape` picks the silhouette: "circle" (default), "hex" (Rocketeer rocket) or
// "star" (detonation pellets). `armorMul` scales the target's armor for this hit
// (<1 pierces, >1 is armor-vulnerable). `pierce` lets it pass through N extra
// targets (Railgun). `knockback` pushes a struck tank.

import { Graphics } from "pixi.js";
import { graphics, drawCircle, darken } from "../render/shapes.js";

export class Bullet {
  constructor({
    x,
    y,
    angle,
    speed,
    radius,
    life,
    damage,
    color,
    bounds = null,
    team = "player",
    shape = "circle",
    armorMul = 1,
    pierce = 0,
    knockback = 0,
    isRocket = false,
  }) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.vx = Math.cos(angle) * speed; // baked once; bullet flies straight
    this.vy = Math.sin(angle) * speed;
    this.radius = radius;
    this.life = life;
    this.damage = damage;
    this.bounds = bounds;
    this.team = team; // who fired it; only damages the other team
    this.shape = shape;
    this.armorMul = armorMul;
    this.pierce = pierce;
    this.knockback = knockback;
    this.isRocket = isRocket;
    this.hitSet = null; // lazily created when a piercing bullet needs to skip repeats
    this.dead = false;

    this.view = this.#build(radius, color, shape);
    this.syncView();
  }

  #build(radius, color, shape) {
    if (shape === "hex" || shape === "star" || shape === "arrow") {
      const g = new Graphics();
      const pts =
        shape === "hex"
          ? polyPoints(6, radius)
          : shape === "star"
            ? starPoints(5, radius, radius * 0.5)
            : arrowPoints(radius); // rocketeer rocket: a forward-pointing dart
      g.poly(pts).fill(color).stroke({ color: darken(color), width: 3, alignment: 0.5 });
      return g;
    }
    return drawCircle(graphics(), 0, 0, radius, color);
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.life -= dt;
    if (this.life <= 0) this.dead = true;

    if (this.bounds) {
      const b = this.bounds;
      if (this.x < b.minX || this.x > b.maxX || this.y < b.minY || this.y > b.maxY) {
        this.dead = true;
      }
    }
  }

  syncView() {
    this.view.position.set(this.x, this.y);
    if (this.shape !== "circle") this.view.rotation = this.angle;
  }
}

// Regular N-gon points (flat list) with the first vertex pointing along +x.
function polyPoints(n, r) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  return out;
}

// A forward-pointing arrowhead/dart (tip along +x), for the Rocketeer rocket.
function arrowPoints(r) {
  return [r * 1.3, 0, -r * 0.7, -r, -r * 0.2, 0, -r * 0.7, r];
}

// N-point star alternating outer/inner radius.
function starPoints(n, outer, inner) {
  const out = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    out.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  return out;
}
