// Toxic fog: a circular safe zone (centered on the arena) that shrinks over the
// match. Anything outside the safe radius takes damage over time — this stops
// camping and squeezes the fight inward. The visible edge is a glowing ring.

import { Graphics } from "pixi.js";
import { GAME } from "../config.js";

export class Fog {
  constructor() {
    this.view = new Graphics();
    this.reset();
  }

  reset() {
    this.radius = GAME.fog.startRadius;
    this.#draw();
  }

  update(dt) {
    this.radius = Math.max(GAME.fog.minRadius, this.radius - GAME.fog.shrinkRate * dt);
    this.#draw();
  }

  // Is the world point outside the safe zone (i.e. taking fog damage)?
  isOutside(x, y) {
    return x * x + y * y > this.radius * this.radius;
  }

  #draw() {
    this.view
      .clear()
      .circle(0, 0, this.radius)
      .stroke({ color: GAME.fog.color, width: 60, alpha: 0.28 }) // hazy band
      .circle(0, 0, this.radius)
      .stroke({ color: GAME.fog.color, width: 6, alpha: 0.9 }); // crisp edge
  }
}
