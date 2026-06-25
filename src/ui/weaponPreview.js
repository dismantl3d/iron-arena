// Builds a flat SVG preview of a weapon mounted on a tank, used by the Arsenal
// cards, the Iron Path track, and the Cosmetics live showcase. Reuses the SAME
// barrel geometry as the in-world tank (render/turret.js) so the preview matches
// the real turret. Optionally renders a body `wrap` (clipped to the circle) so
// the Cosmetics preview reflects color + wrap + weapon. Locked weapons render as
// a faded silhouette (the card adds the lock icon over the top).

import { turretBarrels } from "../render/turret.js";
import { darken } from "../render/shapes.js";
import { hexToCss } from "./dom.js";

const R = 22; // preview tank radius (in SVG units)
let UID = 0;

function lighten(int, t) {
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  const m = (c) => Math.round(c + (255 - c) * t);
  return (m(r) << 16) | (m(g) << 8) | m(b);
}

// weapon: a GAME.weapons entry. opts: { color, locked, wrap }.
export function weaponPreviewSvg(weapon, { color = 0x00b0e9, locked = false, wrap = "none" } = {}) {
  const body = locked ? "#39394a" : hexToCss(color);
  const bodyEdge = locked ? "#23232c" : hexToCss(darken(color));
  const barrel = locked ? "#2c2c36" : "#9aa0a6";
  const barrelEdge = locked ? "#1c1c24" : hexToCss(darken(0x9aa0a6));

  const barrels = turretBarrels(weapon.turret, R)
    .map((b) => {
      const pts = barrelPoints(b)
        .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
        .join(" ");
      return `<polygon points="${pts}" fill="${barrel}" stroke="${barrelEdge}" stroke-width="3" stroke-linejoin="round"/>`;
    })
    .join("");

  const id = `wclip${UID++}`;
  const wrapSvg = locked ? "" : wrapShapes(wrap, color, id);

  return (
    `<svg viewBox="-70 -60 140 120" width="100%" height="100%" aria-hidden="true">` +
    `<defs><clipPath id="${id}"><circle cx="0" cy="0" r="${R}"/></clipPath></defs>` +
    barrels +
    `<circle cx="0" cy="0" r="${R}" fill="${body}" stroke="${bodyEdge}" stroke-width="4"/>` +
    wrapSvg +
    `</svg>`
  );
}

// SVG wrap pattern, clipped to the body circle. Mirrors render/wraps.js.
function wrapShapes(pattern, color, clipId) {
  const dark = hexToCss(darken(color, 0.7));
  const light = hexToCss(lighten(color, 0.4));
  let inner = "";
  switch (pattern) {
    case "striped":
      for (let i = -2; i <= 2; i++) {
        const o = i * R * 0.62;
        inner += `<line x1="${-R + o}" y1="${-R}" x2="${R + o}" y2="${R}" stroke="${dark}" stroke-width="${R * 0.16}" opacity="0.55"/>`;
      }
      break;
    case "camo":
      for (const [bx, by, br] of [[-0.4, -0.3, 0.5], [0.45, -0.1, 0.42], [-0.1, 0.5, 0.46], [0.3, 0.45, 0.3]])
        inner += `<circle cx="${bx * R}" cy="${by * R}" r="${br * R}" fill="${dark}" opacity="0.5"/>`;
      break;
    case "lightning":
      inner += `<polyline points="${R * 0.2},${-R} ${-R * 0.35},${R * 0.05} ${R * 0.05},${R * 0.05} ${-R * 0.2},${R}" fill="none" stroke="${light}" stroke-width="${R * 0.16}" opacity="0.85"/>`;
      break;
    case "carbon": {
      const step = R * 0.5;
      for (let yy = -R; yy < R; yy += step)
        for (let xx = -R; xx < R; xx += step)
          inner += `<rect x="${xx + 1}" y="${yy + 1}" width="${step - 2}" height="${step - 2}" fill="${dark}" opacity="0.28"/>`;
      break;
    }
    default:
      return "";
  }
  return `<g clip-path="url(#${clipId})">${inner}</g>`;
}

// Four corners of one barrel rect, transformed exactly like the Pixi version.
function barrelPoints(b) {
  const local = [
    [0, -b.width / 2],
    [b.length, -b.width / 2],
    [b.length, b.width / 2],
    [0, b.width / 2],
  ];
  const ox = -Math.sin(b.angle) * b.perp;
  const oy = Math.cos(b.angle) * b.perp;
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  return local.map(([x, y]) => [x * c - y * s + ox, x * s + y * c + oy]);
}
