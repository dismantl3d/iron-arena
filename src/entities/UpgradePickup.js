// A world-space upgrade pickup. The player walks over it to collect it. Normal
// upgrades render as a rarity-colored rounded square; specials render as a hex.
// The Game reads `kind` ("normal" | "special"), `typeKey`, and `rarity` on pickup.

import { Container, Graphics } from "pixi.js";
import { darken } from "../render/shapes.js";
import { RARITY_COLOR } from "../game/upgrades.js";

export class UpgradePickup {
  constructor({ x, y, kind, typeKey, rarity = 0 }) {
    this.x = x;
    this.y = y;
    this.kind = kind; // "normal" | "special"
    this.typeKey = typeKey;
    this.rarity = rarity;
    this.radius = kind === "special" ? 26 : 22; // collection radius
    this.collected = false;
    this.dead = false;
    this._t = Math.random() * Math.PI * 2; // bob phase

    const color = kind === "special" ? 0xffd24a : RARITY_COLOR[rarity];
    this.view = new Container();
    const g = new Graphics();
    if (kind === "special") {
      drawHex(g, this.radius, color);
    } else {
      g.roundRect(-this.radius, -this.radius, this.radius * 2, this.radius * 2, 6)
        .fill(color)
        .stroke({ color: darken(color), width: 4 });
    }
    this.view.addChild(g);
    this.syncView();
  }

  update(dt) {
    this._t += dt * 3;
  }

  syncView() {
    this.view.position.set(this.x, this.y);
    this.view.scale.set(1 + Math.sin(this._t) * 0.06); // gentle pulse
  }
}

function drawHex(g, r, color) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    pts.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.poly(pts).fill(color).stroke({ color: darken(color), width: 4 });
}
