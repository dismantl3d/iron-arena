// Toxic fog — the CLIENT view. The authoritative zone state (radius, staged shrink
// cycle, final zone, isOutside) now lives in the renderer-free src/sim/FogModel;
// this class just owns a Pixi `view` and DRAWS the safe-zone rings from the model.
// It re-exposes the model's fields (radius/nextRadius/timer/state) so Game.js and
// the minimap keep using `this.fog.*` exactly as before.

import { Graphics } from "pixi.js";
import { GAME } from "../config.js";
import { FogModel } from "../sim/FogModel.js";

export class Fog {
  constructor() {
    this.model = new FogModel();
    this.view = new Graphics();
    this.#draw();
  }

  // Authoritative state, delegated to the sim model (read-only from the client).
  get radius() { return this.model.radius; }
  get nextRadius() { return this.model.nextRadius; }
  get timer() { return this.model.timer; }
  get state() { return this.model.state; }
  get stage() { return this.model.stage; }

  reset() {
    this.model.reset();
    this.#draw();
  }

  update(dt, mul = 1) {
    this.model.update(dt, mul);
    this.#draw();
  }

  isOutside(x, y) {
    return this.model.isOutside(x, y);
  }

  #draw() {
    const r = this.model.radius;
    this.view
      .clear()
      .circle(0, 0, r)
      .stroke({ color: GAME.fog.color, width: 60, alpha: 0.28 }) // hazy band
      .circle(0, 0, r)
      .stroke({ color: GAME.fog.color, width: 6, alpha: 0.9 }); // crisp edge
  }
}
