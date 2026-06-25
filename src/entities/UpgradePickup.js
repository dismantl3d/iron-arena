// A world-space upgrade pickup. The player walks over it to collect it. It shows
// the SAME glyph as the bottom-left HUD slot (render/upgradeIcons.js): normals
// render as a rarity-ringed circle, specials as a hexagon. The Game reads
// `kind` ("normal" | "special"), `typeKey`, and `rarity` on pickup.

import { Container, Graphics } from "pixi.js";
import { darken } from "../render/shapes.js";
import { drawUpgradeIcon } from "../render/upgradeIcons.js";
import { RARITY_COLOR } from "../game/upgrades.js";

const SPECIAL_COLOR = 0xffd24a;

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

    const r = this.radius;
    this.view = new Container();
    const g = new Graphics();
    if (kind === "special") {
      drawHex(g, r, 0x2b2b34, SPECIAL_COLOR); // dark hex, gold frame
      drawUpgradeIcon(g, typeKey, SPECIAL_COLOR, r * 0.5);
    } else {
      const color = RARITY_COLOR[rarity];
      g.circle(0, 0, r).fill(0xf2f4f8).stroke({ color: darken(color), width: 3 }); // light disc
      g.circle(0, 0, r).stroke({ color, width: 4 }); // rarity ring
      drawUpgradeIcon(g, typeKey, darken(color, 0.8), r * 0.52);
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

function drawHex(g, r, fill, stroke) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    pts.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.poly(pts).fill(fill).stroke({ color: stroke, width: 4 });
}
