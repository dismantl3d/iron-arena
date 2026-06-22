// A bullet travels in a straight line from the moment it spawns, independent of
// the tank that fired it. It dies when its lifetime runs out or it leaves the
// arena; the Game also kills it on collision. Cleanup is handled by the Engine
// once `dead` is set.

import { graphics, drawCircle } from "../render/shapes.js";

export class Bullet {
  constructor({ x, y, angle, speed, radius, life, damage, color, bounds = null, team = "player" }) {
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * speed; // baked once; bullet flies straight
    this.vy = Math.sin(angle) * speed;
    this.radius = radius;
    this.life = life;
    this.damage = damage;
    this.bounds = bounds;
    this.team = team; // who fired it; only damages the other team
    this.dead = false;

    this.view = drawCircle(graphics(), 0, 0, radius, color);
    this.syncView();
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
  }
}
