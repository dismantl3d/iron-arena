// Diep.io-style shape helpers: every shape gets a bold outline that is a
// darker shade of its own fill color. Centralizing this keeps the look
// consistent across every entity.

import { Graphics } from "pixi.js";
import { OUTLINE } from "../config.js";

// Returns a darker shade of `color` (0xRRGGBB) by scaling each channel.
export function darken(color, factor = OUTLINE.darken) {
  const r = Math.floor(((color >> 16) & 0xff) * factor);
  const g = Math.floor(((color >> 8) & 0xff) * factor);
  const b = Math.floor((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

// Draw a filled circle with a bold darker outline onto an existing Graphics.
export function drawCircle(g, x, y, radius, color, width = OUTLINE.width) {
  g.circle(x, y, radius)
    .fill(color)
    .stroke({ color: darken(color), width, alignment: 0.5 });
  return g;
}

// Draw a filled rectangle (centered on x,y by default) with a bold outline.
export function drawRect(g, x, y, w, h, color, width = OUTLINE.width) {
  g.rect(x - w / 2, y - h / 2, w, h)
    .fill(color)
    .stroke({ color: darken(color), width, alignment: 0.5 });
  return g;
}

// Convenience: a fresh Graphics object the caller can configure.
export function graphics() {
  return new Graphics();
}
