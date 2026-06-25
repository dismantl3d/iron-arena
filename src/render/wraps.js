// Wrap patterns drawn INSIDE the tank body. The caller draws onto a Graphics
// that is masked to the body circle, so patterns never overflow the circle.
// Placeholders — flat, subtle, derived from the body color so any cosmetic color
// reads well. `r` is the body radius.

import { darken } from "./shapes.js";

// Lighten a color toward white by `t` (0..1).
function lighten(color, t) {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const m = (c) => Math.round(c + (255 - c) * t);
  return (m(r) << 16) | (m(g) << 8) | m(b);
}

export function drawWrap(g, pattern, r, baseColor) {
  g.clear();
  const dark = darken(baseColor, 0.7);
  const light = lighten(baseColor, 0.4);
  const lw = Math.max(2, r * 0.16);

  switch (pattern) {
    case "striped": {
      for (let i = -2; i <= 2; i++) {
        const o = i * r * 0.62;
        g.moveTo(-r + o, -r).lineTo(r + o, r).stroke({ color: dark, width: lw, alpha: 0.55 });
      }
      break;
    }
    case "camo": {
      const blobs = [
        [-0.4, -0.3, 0.5],
        [0.45, -0.1, 0.42],
        [-0.1, 0.5, 0.46],
        [0.3, 0.45, 0.3],
      ];
      for (const [bx, by, br] of blobs) {
        g.circle(bx * r, by * r, br * r).fill({ color: dark, alpha: 0.5 });
      }
      break;
    }
    case "lightning": {
      g.moveTo(r * 0.2, -r)
        .lineTo(-r * 0.35, r * 0.05)
        .lineTo(r * 0.05, r * 0.05)
        .lineTo(-r * 0.2, r)
        .stroke({ color: light, width: lw, alpha: 0.85 });
      break;
    }
    case "carbon": {
      const step = r * 0.5;
      for (let yy = -r; yy < r; yy += step) {
        for (let xx = -r; xx < r; xx += step) {
          g.rect(xx + 1, yy + 1, step - 2, step - 2).fill({ color: dark, alpha: 0.28 });
        }
      }
      break;
    }
    default:
      break; // "none"
  }
}
