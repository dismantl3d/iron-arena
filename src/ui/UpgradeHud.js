// In-match upgrade HUD, bottom-right (Pixi, on app.stage). Five normal-upgrade
// slots (icon + rarity progress bar, no text labels) stacked above two special
// hex slots. Hovering a slot shows a CUSTOM tooltip (name / rarity / effect) —
// no browser title tooltips. Call refresh(upgradeState) when upgrades change.

import { Container, Graphics, Text } from "pixi.js";
import { NORMAL_TYPES, SPECIALS, RARITIES, RARITY_COLOR } from "../game/upgrades.js";
import { COLORS } from "../config.js";

const ICON = 42;
const BAR_H = 6;
const ROW = 56;
const HEX = 38;
const MARGIN = 16;

export class UpgradeHud {
  constructor(app) {
    this.app = app;
    this.state = null;

    this.view = new Container();
    app.stage.addChild(this.view);

    this.normals = NORMAL_TYPES.map((type) => this.#buildSlot(type.key, "normal"));
    this.specials = [0, 1].map((i) => this.#buildSlot(i, "special"));

    this.tooltip = this.#buildTooltip();
    this.view.addChild(this.tooltip);
    this.tooltip.visible = false;

    this.layout();
  }

  #buildSlot(id, kind) {
    const w = new Container();
    w.eventMode = "static";
    w.cursor = "pointer";
    const base = new Graphics();
    const glyph = new Graphics();
    const bar = new Graphics();
    w.addChild(base, glyph, bar);
    this.view.addChild(w);

    const slot = { id, kind, w, base, glyph, bar };
    w.on("pointerover", () => this.#showTip(slot));
    w.on("pointerout", () => (this.tooltip.visible = false));
    return slot;
  }

  #buildTooltip() {
    const c = new Container();
    c.bg = new Graphics();
    c.name = new Text({ text: "", style: { fill: COLORS.hudText, fontFamily: "Arial", fontSize: 14, fontWeight: "bold" } });
    c.rarity = new Text({ text: "", style: { fill: COLORS.hudDim, fontFamily: "Arial", fontSize: 12 } });
    c.effect = new Text({ text: "", style: { fill: COLORS.hudDim, fontFamily: "Arial", fontSize: 12, wordWrap: true, wordWrapWidth: 180 } });
    c.name.position.set(10, 8);
    c.rarity.position.set(10, 28);
    c.effect.position.set(10, 46);
    c.addChild(c.bg, c.name, c.rarity, c.effect);
    return c;
  }

  // Lay slots out bottom-right: normals stacked, specials in a row beneath.
  layout() {
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    const right = W - MARGIN;

    // Two special hexes along the bottom.
    const spY = H - MARGIN - HEX;
    this.specials.forEach((s, i) => {
      s.w.position.set(right - HEX - i * (HEX + 10), spY);
    });

    // Normal slots stacked upward above the specials.
    const topOfSpecials = spY - 14;
    this.normals.forEach((s, i) => {
      const y = topOfSpecials - (this.normals.length - i) * ROW;
      s.w.position.set(right - ICON, y);
    });

    if (this.state) this.refresh(this.state);
  }

  refresh(state) {
    this.state = state;

    this.normals.forEach((s) => {
      const rarity = state.normals[s.id]; // undefined if not collected
      const has = rarity !== undefined;
      const color = has ? RARITY_COLOR[rarity] : 0x33333d;

      s.base.clear().roundRect(0, 0, ICON, ICON, 8).fill(0x23232c).stroke({ color, width: 2 });
      s.glyph.clear();
      drawGlyph(s.glyph, s.id, has ? 0xffffff : 0x55555f);
      s.glyph.position.set(ICON / 2, ICON / 2);

      // rarity progress bar beneath the icon
      const frac = has ? (rarity + 1) / RARITIES.length : 0;
      s.bar
        .clear()
        .roundRect(0, ICON + 4, ICON, BAR_H, 2)
        .fill(0x2a2a2a)
        .roundRect(0, ICON + 4, ICON * frac, BAR_H, 2)
        .fill(color);
    });

    this.specials.forEach((s) => {
      const key = state.specials[s.id]; // undefined if empty
      const filled = key !== undefined;
      const color = filled ? 0xffd24a : 0x33333d;
      s.base.clear();
      drawHex(s.base, HEX / 2, 0x23232c, color);
      s.base.position.set(HEX / 2, HEX / 2);
      s.glyph.clear();
      if (filled) {
        s.glyph.circle(HEX / 2, HEX / 2, 5).fill(color);
      }
    });
  }

  #showTip(slot) {
    const t = this.tooltip;
    let name, rarity, effect;
    if (slot.kind === "normal") {
      const def = NORMAL_TYPES.find((x) => x.key === slot.id);
      const r = this.state?.normals[slot.id];
      name = def.name;
      rarity = r !== undefined ? RARITIES[r] : "Not collected";
      effect = def.effect;
    } else {
      const key = this.state?.specials[slot.id];
      if (key) {
        const def = SPECIALS.find((x) => x.key === key);
        name = def.name;
        rarity = "Special";
        effect = def.effect;
      } else {
        name = "Special Slot";
        rarity = "Empty";
        effect = "Collect a special upgrade (max 2)";
      }
    }

    t.name.text = name;
    t.rarity.text = rarity;
    t.effect.text = effect;
    const w = 200;
    const h = 70;
    t.bg.clear().roundRect(0, 0, w, h, 8).fill({ color: 0x12121a, alpha: 0.96 }).stroke({ color: COLORS.menuBorder, width: 2 });
    // place to the left of the hovered slot
    t.position.set(slot.w.x - w - 10, slot.w.y - (h - ICON) / 2);
    t.visible = true;
  }
}

// Simple distinct glyph per normal upgrade type (drawn centered at 0,0).
function drawGlyph(g, key, color) {
  const s = 9;
  switch (key) {
    case "bulletSpeed": // arrow
      g.poly([-s, -s, s, 0, -s, s]).fill(color);
      break;
    case "bulletRange": // long bar
      g.roundRect(-s - 2, -2, (s + 2) * 2, 4, 2).fill(color);
      break;
    case "reloadSpeed": // ring
      g.circle(0, 0, s).stroke({ color, width: 3 });
      break;
    case "tankArmor": // shield
      g.poly([0, -s, s, -s + 4, s - 1, s - 3, 0, s, -s + 1, s - 3, -s, -s + 4]).fill(color);
      break;
    case "moveSpeed": // chevrons
      g.poly([-s, -s, -2, 0, -s, s]).stroke({ color, width: 3 });
      g.poly([0, -s, s - 2, 0, 0, s]).stroke({ color, width: 3 });
      break;
    default:
      g.circle(0, 0, s).fill(color);
  }
}

function drawHex(g, r, fill, stroke) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    pts.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.poly(pts).fill(fill).stroke({ color: stroke, width: 2 });
}
