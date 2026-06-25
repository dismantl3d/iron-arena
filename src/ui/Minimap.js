// Screen-space minimap (Pixi, on app.stage so it doesn't pan/zoom). Top-right
// box showing flat, high-contrast dots for the player, bots, Arena Guardians,
// and crates, plus the toxic-fog boundary ring. No glow/blur — solid fills only.
//
// Call update(state) each playing frame with world-space actors; the map scales
// the arena (half-extent = WORLD.arenaHalf) into the box and clips to it.

import { Container, Graphics } from "pixi.js";
import { COLORS, WORLD } from "../config.js";

const SIZE = 168; // box side in px
const MARGIN = 16;
const PAD = 6; // inner padding so dots near the edge stay inside the border

const DOT = {
  player: { color: 0xffffff, r: 4 },
  bot: { color: 0xe2564b, r: 3 },
  guardian: { color: 0x9a3b3b, r: 5 },
  crate: { color: COLORS.xpFill, r: 3 }, // gold squares
};

export class Minimap {
  constructor(app) {
    this.app = app;
    this.view = new Container();
    app.stage.addChild(this.view);

    this.panel = new Graphics();
    this.dots = new Graphics();
    this.mask = new Graphics();
    this.view.addChild(this.panel, this.dots, this.mask);
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
  }

  // Map a world coordinate into the box.
  #toMap(x, y) {
    const scale = (SIZE - PAD * 2) / (WORLD.arenaHalf * 2);
    return { mx: SIZE / 2 + x * scale, my: SIZE / 2 + y * scale };
  }

  // state: { player, bots, guardians, crates, fogRadius }
  update(state) {
    const g = this.dots.clear();
    const scale = (SIZE - PAD * 2) / (WORLD.arenaHalf * 2);

    // fog boundary ring (clipped to the box by the mask)
    if (state.fogRadius) {
      g.circle(SIZE / 2, SIZE / 2, state.fogRadius * scale).stroke({
        color: COLORS.menuBorder,
        width: 1.5,
      });
      g.circle(SIZE / 2, SIZE / 2, state.fogRadius * scale).stroke({
        color: 0xa64bff,
        width: 2,
      });
    }

    // walls as faint gray rectangles (drawn first, under the dots)
    for (const w of state.walls || []) {
      const a = this.#toMap(w.minX, w.minY);
      const b = this.#toMap(w.maxX, w.maxY);
      g.rect(a.mx, a.my, Math.max(1, b.mx - a.mx), Math.max(1, b.my - a.my)).fill({ color: 0x6c7280, alpha: 0.9 });
    }

    for (const c of state.crates || []) this.#square(g, c, DOT.crate);
    for (const b of state.bots || []) this.#dot(g, b, DOT.bot);
    for (const gd of state.guardians || []) this.#dot(g, gd, DOT.guardian);
    if (state.player && !state.player.dead) this.#dot(g, state.player, DOT.player, true);
  }

  #dot(g, e, def, ring = false) {
    const { mx, my } = this.#toMap(e.x, e.y);
    g.circle(mx, my, def.r).fill(def.color);
    if (ring) g.circle(mx, my, def.r + 2).stroke({ color: def.color, width: 1.5 });
  }

  #square(g, e, def) {
    const { mx, my } = this.#toMap(e.x, e.y);
    const s = def.r;
    g.rect(mx - s, my - s, s * 2, s * 2).fill(def.color);
  }
}
