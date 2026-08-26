// Authoritative toxic-fog / zone state — renderer-free (no Pixi). Owns the safe
// radius, the staged shrink cycle (hold → contract → hold), the final battle zone,
// and the "is this point outside the safe zone?" test used for fog damage. The
// client's Pixi `Fog` wraps one of these and only DRAWS from it; the server/world
// model can own one to be the authority over the zone. Timing/dimensions come from
// GAME.fog — unchanged, so behavior is identical to the old inline Fog logic.

import { GAME } from "../config.js";

export class FogModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.stage = 0; // completed shrink stages
    this.state = "holding"; // "holding" | "shrinking"
    this.timer = GAME.fog.holdTime;
    this.radius = GAME.fog.startRadius;
    this.from = this.radius;
    this.to = this.radius;
    this.nextRadius = this.#target(1);
  }

  // The safe radius after `n` completed shrink stages (linear start → final).
  #target(n) {
    const { startRadius, finalRadius, stages } = GAME.fog;
    if (n >= stages) return finalRadius;
    return startRadius + (finalRadius - startRadius) * (n / stages);
  }

  // `mul` accelerates the whole cycle during the endgame (see GAME.endgame).
  update(dt, mul = 1) {
    if (this.stage >= GAME.fog.stages) {
      this.nextRadius = null; // final zone reached — no more shrinking
      return;
    }

    this.timer -= dt * mul;
    if (this.state === "holding") {
      if (this.timer <= 0) {
        this.state = "shrinking";
        this.from = this.radius;
        this.to = this.#target(this.stage + 1);
        this.timer = GAME.fog.shrinkTime;
      }
    } else {
      const t = 1 - Math.max(0, this.timer) / GAME.fog.shrinkTime;
      this.radius = this.from + (this.to - this.from) * t;
      if (this.timer <= 0) {
        this.radius = this.to;
        this.stage += 1;
        this.state = "holding";
        this.timer = GAME.fog.holdTime;
      }
    }

    this.nextRadius =
      this.stage >= GAME.fog.stages
        ? null
        : this.state === "shrinking"
          ? this.to
          : this.#target(this.stage + 1);
  }

  // Is the world point outside the safe zone (i.e. taking fog damage)?
  isOutside(x, y) {
    return x * x + y * y > this.radius * this.radius;
  }
}
