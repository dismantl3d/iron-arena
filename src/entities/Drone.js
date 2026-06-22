// A small drone that orbits the player, granted by a special upgrade.
//   kind "sentry" — periodically fires at the nearest enemy (framework AI)
//   kind "loot"   — cosmetic companion; the pickup-range bonus is applied in Game
// Framework only — light behavior, no balancing.

import { graphics, drawCircle } from "../render/shapes.js";

export class Drone {
  constructor({ kind, player, game, phase = 0 }) {
    this.kind = kind;
    this.player = player;
    this.game = game;
    this.angle = phase; // orbit position
    this.radius = 9;
    this.x = player.x;
    this.y = player.y;
    this.dead = false;
    this._fire = 0.6;

    const color = kind === "sentry" ? 0xff7a59 : 0x76d672;
    this.view = drawCircle(graphics(), 0, 0, this.radius, color);
    this.syncView();
  }

  update(dt) {
    if (this.player.dead) {
      this.dead = true;
      return;
    }
    this.angle += dt * 2.2;
    const orbit = 64;
    this.x = this.player.x + Math.cos(this.angle) * orbit;
    this.y = this.player.y + Math.sin(this.angle) * orbit;

    if (this.kind === "sentry") {
      this._fire -= dt;
      if (this._fire <= 0) {
        const target = this.#nearestEnemy(900);
        if (target) {
          const a = Math.atan2(target.y - this.y, target.x - this.x);
          this.game.spawnDroneBullet(this.x, this.y, a);
          this._fire = 0.7;
        }
      }
    }
  }

  #nearestEnemy(range) {
    let best = range;
    let found = null;
    const consider = (t) => {
      if (!t || t.dead) return;
      const d = Math.hypot(t.x - this.x, t.y - this.y);
      if (d < best) {
        best = d;
        found = t;
      }
    };
    for (const b of this.game.bots) consider(b);
    for (const gd of this.game.guardians) consider(gd);
    return found;
  }

  syncView() {
    this.view.position.set(this.x, this.y);
  }
}
