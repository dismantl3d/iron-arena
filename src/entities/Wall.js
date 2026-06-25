// A static, impassable wall: a simple world-toned rectangle that blocks tank
// movement and stops bullets. Positioned by its CENTER (x, y) with full width/
// height (w, h). The Game does circle-vs-rect resolution against `bounds`.

import { Graphics } from "pixi.js";
import { COLORS } from "../config.js";
import { darken } from "../render/shapes.js";

export class Wall {
  constructor({ x, y, w, h }) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.dead = false;

    // AABB edges for collision.
    this.minX = x - w / 2;
    this.maxX = x + w / 2;
    this.minY = y - h / 2;
    this.maxY = y + h / 2;

    this.view = new Graphics()
      .rect(this.minX, this.minY, w, h)
      .fill(COLORS.wall)
      .stroke({ color: darken(COLORS.wall), width: 6, alignment: 0 });
  }

  // No per-frame state; the view is drawn in world coordinates already.
  syncView() {}
}
