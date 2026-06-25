// In-match upgrade HUD, BOTTOM-LEFT (Pixi, on app.stage). Five normal-upgrade
// slots — a rarity-ringed CIRCLE with a flat icon (render/upgradeIcons.js, the
// same glyph the world pickups use) — stacked above a separate row of two
// hexagonal SPECIAL slots. Hovering a slot shows a CUSTOM animated tooltip
// (name / type / effect) — no browser title tooltips. Call refresh(state) when
// upgrades change.

import { Container, Graphics, Text } from "pixi.js";
import { NORMAL_TYPES, SPECIALS, RARITIES, RARITY_COLOR } from "../game/upgrades.js";
import { drawUpgradeIcon } from "../render/upgradeIcons.js";
import { COLORS } from "../config.js";

const R = 23; // normal slot circle radius
const ROW = 56; // vertical spacing between normal slots
const HEX = 40; // special hex slot size (point-to-point)
const MARGIN = 16;
const EMPTY = 0x33333d;

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
    w.addChild(base, glyph); // drawn centered at (0,0) of this container
    this.view.addChild(w);

    const slot = { id, kind, w, base, glyph };
    w.on("pointerover", () => this.#showTip(slot));
    w.on("pointerout", () => (this.tooltip.visible = false));
    return slot;
  }

  #buildTooltip() {
    const c = new Container();
    c.bg = new Graphics();
    c.name = new Text({ text: "", style: { fill: 0xffffff, fontFamily: "Ubuntu, Arial", fontSize: 14, fontWeight: "bold" } });
    c.type = new Text({ text: "", style: { fill: 0x9aa0b0, fontFamily: "Ubuntu, Arial", fontSize: 12, fontWeight: "bold" } });
    c.effect = new Text({ text: "", style: { fill: 0x9aa0b0, fontFamily: "Ubuntu, Arial", fontSize: 12, wordWrap: true, wordWrapWidth: 180 } });
    c.name.position.set(12, 9);
    c.type.position.set(12, 29);
    c.effect.position.set(12, 47);
    c.addChild(c.bg, c.name, c.type, c.effect);
    return c;
  }

  // Lay slots out bottom-left: specials in a row at the bottom, normals stacked
  // upward above them. Each slot container is positioned at its CENTER.
  layout() {
    const H = this.app.screen.height;

    const spCY = H - MARGIN - HEX / 2;
    this.specials.forEach((s, i) => {
      s.w.position.set(MARGIN + HEX / 2 + i * (HEX + 12), spCY);
    });

    const topOfSpecials = spCY - HEX / 2 - 14;
    this.normals.forEach((s, i) => {
      const cy = topOfSpecials - (this.normals.length - i) * ROW + R;
      s.w.position.set(MARGIN + R, cy);
    });

    if (this.state) this.refresh(this.state);
  }

  refresh(state) {
    this.state = state;

    this.normals.forEach((s) => {
      const rarity = state.normals[s.id]; // undefined if not collected
      const has = rarity !== undefined;
      const ring = has ? RARITY_COLOR[rarity] : EMPTY;

      s.base
        .clear()
        .circle(0, 0, R)
        .fill(0x23232c)
        .stroke({ color: ring, width: 4 }); // rarity ring
      s.glyph.clear();
      drawUpgradeIcon(s.glyph, s.id, has ? 0xffffff : 0x55555f, R * 0.52);
    });

    this.specials.forEach((s) => {
      const key = state.specials[s.id]; // undefined if empty
      const filled = key !== undefined;
      const color = filled ? 0xffd24a : EMPTY;
      s.base.clear();
      drawHex(s.base, HEX / 2, 0x23232c, color);
      s.glyph.clear();
      if (filled) drawUpgradeIcon(s.glyph, key, color, HEX * 0.28);
    });
  }

  #showTip(slot) {
    const t = this.tooltip;
    let name, type, effect;
    if (slot.kind === "normal") {
      const def = NORMAL_TYPES.find((x) => x.key === slot.id);
      const r = this.state?.normals[slot.id];
      name = def.name;
      type = r !== undefined ? `Upgrade · ${RARITIES[r]}` : "Upgrade";
      effect = def.effect;
    } else {
      const key = this.state?.specials[slot.id];
      if (key) {
        const def = SPECIALS.find((x) => x.key === key);
        name = def.name;
        type = "Special";
        effect = def.effect;
      } else {
        name = "Special Slot";
        type = "Empty";
        effect = "Collect a special upgrade (max 2)";
      }
    }

    t.name.text = name;
    t.type.text = type;
    t.effect.text = effect;
    const w = 200;
    const h = 72;
    t.bg
      .clear()
      .roundRect(0, 0, w, h, 8)
      .fill({ color: 0x12121a, alpha: 0.96 })
      .stroke({ color: COLORS.menuBorder, width: 2 });
    // place to the RIGHT of the hovered slot (HUD is on the left edge)
    t.position.set(slot.w.x + R + 12, slot.w.y - h / 2);
    t.visible = true;
    t.alpha = 0; // small fade-in
    t.scale.set(0.96);
    this.#animateTip();
  }

  #animateTip() {
    const t = this.tooltip;
    const start = performance.now();
    const step = () => {
      if (!t.visible) return;
      const k = Math.min(1, (performance.now() - start) / 110);
      t.alpha = k;
      t.scale.set(0.96 + 0.04 * k);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

function drawHex(g, r, fill, stroke) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    pts.push(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.poly(pts).fill(fill).stroke({ color: stroke, width: 3 });
}
