// A world-space loot crate: a container holding 3 upgrade items. The player
// opens it by touching it (the Game grants the items + bursts it open). Rendered
// Copter-Royale style: a chunky BROWN reinforced box (bigger than a tank), bold
// darker outline, corner rivets, and a banded lid — rarity is NOT shown. The
// Game reads `items` (array of {kind,typeKey,rarity}); set `dead = true` to open.

import { Container, Graphics } from "pixi.js";
import { COLORS, GAME } from "../config.js";

export class Crate {
  constructor({ x, y, rarity = 0, items = [] }) {
    this.x = x;
    this.y = y;
    this.rarity = rarity; // kept for loot rolls; not shown
    this.items = items;
    this.radius = GAME.crate.radius;
    this.dead = false;
    this._t = Math.random() * Math.PI * 2; // bob phase

    const r = this.radius;
    this.view = new Container();
    const g = new Graphics();

    // body
    g.roundRect(-r, -r, r * 2, r * 2, 8).fill(COLORS.crate).stroke({ color: COLORS.crateEdge, width: 6 });
    // reinforcing bands (a plus across the lid)
    g.rect(-r, -r * 0.16, r * 2, r * 0.32).fill(COLORS.crateEdge);
    g.rect(-r * 0.16, -r, r * 0.32, r * 2).fill(COLORS.crateEdge);
    // corner rivets
    const cr = r * 0.78;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      g.circle(dx * cr, dy * cr, r * 0.12).fill(COLORS.crateEdge);
    }

    this.view.addChild(g);
    this.syncView();
  }

  update(dt) {
    this._t += dt * 2.2;
  }

  syncView() {
    this.view.position.set(this.x, this.y);
    this.view.scale.set(1 + Math.sin(this._t) * 0.04);
  }
}
