// BotBrain is a tank's AI controller. Each frame the Tank calls think(dt, tank)
// and gets back a movement direction + desired turret aim. The behavior is kept
// deliberately simple (this is a placeholder AI):
//
//   - wander: pick a new heading every few seconds and ease toward it (no jitter)
//   - wall avoidance: when near the arena edge, steer back toward open space
//   - separation: blend away from nearby bots so they don't clump (the steering
//     vector is computed by the Game, which has the bot list, and stored here)
//   - aim: the turret faces the movement direction
//
// Bots also fire periodically — but that's driven by the Tank's own fire
// cooldown in the Game, not here.

import { approachAngle } from "../utils/angle.js";
import { GAME } from "../config.js";

export class BotBrain {
  constructor() {
    this.heading = Math.random() * Math.PI * 2; // current travel direction
    this.targetHeading = this.heading; // where we're steering toward
    this._timer = this.#nextInterval();
    // Separation steering, written by Game.#separateBots() each frame.
    this.avoidX = 0;
    this.avoidY = 0;
  }

  #nextInterval() {
    const [a, b] = GAME.bot.directionInterval;
    return a + Math.random() * (b - a);
  }

  think(dt, tank) {
    // 1. Every few seconds, choose a fresh wander direction.
    this._timer -= dt;
    if (this._timer <= 0) {
      this.targetHeading = Math.random() * Math.PI * 2;
      this._timer = this.#nextInterval();
    }

    // 2. Steer back toward open space when approaching a wall (overrides wander).
    const b = tank.bounds;
    const margin = 320;
    let wx = 0;
    let wy = 0;
    if (tank.x < b.minX + margin) wx += 1;
    if (tank.x > b.maxX - margin) wx -= 1;
    if (tank.y < b.minY + margin) wy += 1;
    if (tank.y > b.maxY - margin) wy -= 1;
    if (wx || wy) this.targetHeading = Math.atan2(wy, wx);

    // 3. Blend in separation from nearby bots (anti-clump).
    if (this.avoidX || this.avoidY) {
      const sep = Math.atan2(this.avoidY, this.avoidX);
      this.targetHeading = approachAngle(this.targetHeading, sep, 0.45);
    }

    // 4. Ease the actual heading toward the target so turns feel natural.
    this.heading = approachAngle(this.heading, this.targetHeading, 2.5 * dt);

    return {
      move: { x: Math.cos(this.heading), y: Math.sin(this.heading) },
      aim: this.heading, // turret follows movement direction
    };
  }
}
