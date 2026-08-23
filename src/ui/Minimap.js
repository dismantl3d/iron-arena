// Screen-space minimap (Pixi, on app.stage so it doesn't pan/zoom). Top-right
// box. What it reveals is deliberately limited: it always shows the PLAYER, the
// obstacles (walls), and the toxic-fog zones (current safe ring + a dashed
// "next zone"). Enemy tanks are ONLY shown when the Radar special is equipped;
// Arena Guardians, crates, and upgrades are never shown.
//
// Call update(state) each playing frame with world-space actors; the map scales
// the arena (half-extent = WORLD.arenaHalf) into the box and clips to it.

import { Container, Graphics, Text } from "pixi.js";
import { COLORS, WORLD } from "../config.js";

const SIZE = 168; // box side in px
const MARGIN = 16;
const PAD = 6; // inner padding so dots near the edge stay inside the border

const DOT = {
  player: { color: 0xffffff, r: 4 },
  bot: { color: 0xe2564b, r: 3 }, // only revealed with the Radar special
};

export class Minimap {
  constructor(app) {
    this.app = app;
    this.view = new Container();
    app.stage.addChild(this.view);

    this.panel = new Graphics();
    this.dots = new Graphics();
    this.mask = new Graphics();
    // Fog countdown chip, sits just below the map box.
    this.timerChip = new Graphics();
    this.timerLabel = new Text({
      text: "",
      style: { fill: 0xffffff, fontFamily: "Ubuntu, Arial", fontSize: 13, fontWeight: "bold" },
    });
    this.timerLabel.anchor.set(0.5);
    this.view.addChild(this.panel, this.dots, this.mask, this.timerChip, this.timerLabel);
    this.dots.mask = this.mask;

    this.layout();
  }

  layout() {
    const W = this.app.screen.width;
    this.view.position.set(W - SIZE - MARGIN, MARGIN);

    this.panel
      .clear()
      .roundRect(0, 0, SIZE, SIZE, 8)
      .fill({ color: 0x14141a, alpha: 0.85 })
      .stroke({ color: COLORS.menuBorder, width: 3 });
    this.mask.clear().roundRect(0, 0, SIZE, SIZE, 8).fill(0xffffff);

    // Countdown chip below the box.
    const chipH = 26;
    const chipY = SIZE + 8;
    this.timerChip
      .clear()
      .roundRect(0, chipY, SIZE, chipH, 8)
      .fill({ color: 0x14141a, alpha: 0.85 })
      .stroke({ color: COLORS.menuBorder, width: 3 });
    this.timerLabel.position.set(SIZE / 2, chipY + chipH / 2);
  }

  // Map a world coordinate into the box.
  #toMap(x, y) {
    const scale = (SIZE - PAD * 2) / (WORLD.arenaHalf * 2);
    return { mx: SIZE / 2 + x * scale, my: SIZE / 2 + y * scale };
  }

  // state: { player, bots, fogRadius, fogNextRadius, walls, radar,
  //          fogTimer, fogShrinking, fogFinal }
  update(state) {
    const g = this.dots.clear();
    const scale = (SIZE - PAD * 2) / (WORLD.arenaHalf * 2);
    const cx = SIZE / 2;

    this.#updateTimer(state);

    // next safe zone (dashed, translucent) — where the fog will shrink to
    if (state.fogNextRadius) this.#dashedCircle(g, cx, cx, state.fogNextRadius * scale, 0xa64bff);

    // current fog boundary ring (clipped to the box by the mask)
    if (state.fogRadius) {
      g.circle(cx, cx, state.fogRadius * scale).stroke({ color: COLORS.menuBorder, width: 1.5 });
      g.circle(cx, cx, state.fogRadius * scale).stroke({ color: 0xa64bff, width: 2 });
    }

    // obstacles as faint gray rectangles (always visible)
    for (const w of state.walls || []) {
      const a = this.#toMap(w.minX, w.minY);
      const b = this.#toMap(w.maxX, w.maxY);
      g.rect(a.mx, a.my, Math.max(1, b.mx - a.mx), Math.max(1, b.my - a.my)).fill({ color: 0x6c7280, alpha: 0.9 });
    }

    // Enemy tanks are revealed ONLY with the Radar special. Guardians, crates and
    // upgrades are never shown.
    if (state.radar) for (const b of state.bots || []) this.#dot(g, b, DOT.bot);

    if (state.player && !state.player.dead) this.#dot(g, state.player, DOT.player, true);
  }

  // The fog countdown chip: seconds until the next shrink, or the current state.
  #updateTimer(state) {
    if (state.fogFinal) {
      this.timerLabel.text = "FINAL ZONE";
      this.timerLabel.style.fill = 0x76d672; // green — no more shrinking
    } else if (state.fogShrinking) {
      this.timerLabel.text = "FOG MOVING";
      this.timerLabel.style.fill = 0xff6a6a; // red — contracting now
    } else {
      const s = Math.max(0, Math.ceil(state.fogTimer || 0));
      this.timerLabel.text = `Fog shrinks in ${s}s`;
      this.timerLabel.style.fill = s <= 5 ? 0xffd24a : 0xffffff; // gold when close
    }
  }

  // Approximate a dashed circle with short arc segments (Pixi has no dash style).
  #dashedCircle(g, cx, cy, r, color) {
    if (r < 2) return;
    const segs = 40;
    for (let i = 0; i < segs; i += 2) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      g.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
      g.arc(cx, cy, r, a0, a1);
    }
    g.stroke({ color, width: 1.5, alpha: 0.55 });
  }

  #dot(g, e, def, ring = false) {
    const { mx, my } = this.#toMap(e.x, e.y);
    g.circle(mx, my, def.r).fill(def.color);
    if (ring) g.circle(mx, my, def.r + 2).stroke({ color: def.color, width: 1.5 });
  }
}
