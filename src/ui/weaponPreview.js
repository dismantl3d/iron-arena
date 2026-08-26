// Builds a flat SVG preview of a weapon mounted on a tank, used by the Arsenal
// cards, the Iron Path track, and the Cosmetics live showcase. Reuses the SAME
// barrel geometry as the in-world tank (render/turret.js) so the preview matches
// the real turret. Optionally renders a body `wrap` (clipped to the circle) so
// the Cosmetics preview reflects color + wrap + weapon. Locked weapons render as
// a faded silhouette (the card adds the lock icon over the top).

import { turretBarrels } from "../render/turret.js";
import { darken } from "../render/shapes.js";
import { COLORS } from "../config.js";
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

// weapon: a GAME.weapons entry. opts: { color, locked, wrap, gradient:[c1,c2,dir] }.
export function weaponPreviewSvg(weapon, { color = 0x00b0e9, locked = false, wrap = "none", gradient = null } = {}) {
  const gid = `wgrad${UID}`;
  let body = locked ? "#39394a" : hexToCss(color);
  let gradDef = "";
  if (gradient && !locked) {
    const [x1, y1, x2, y2] = gradient[2] === "tr-bl" ? [1, 0, 0, 1] : [0, 0, 1, 1];
    gradDef = `<linearGradient id="${gid}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${hexToCss(gradient[0])}"/><stop offset="1" stop-color="${hexToCss(gradient[1])}"/></linearGradient>`;
    body = `url(#${gid})`;
  }
  const bodyEdge = locked ? "#23232c" : hexToCss(darken(color));
  const barrelFill = locked ? 0x2c2c36 : COLORS.tankBarrel;

  const barrels = turretBarrels(weapon.turret, R)
    .map((b) => svgBarrel(b, barrelFill))
    .join("");

  const id = `wclip${UID++}`;
  const wrapSvg = locked ? "" : wrapShapes(wrap, color, id);

  return (
    `<svg viewBox="-70 -60 140 120" width="100%" height="100%" aria-hidden="true">` +
    `<defs>${gradDef}<clipPath id="${id}"><circle cx="0" cy="0" r="${R}"/></clipPath></defs>` +
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
    case "metal": {
      const step = R * 0.52;
      const d = step * 0.34;
      let row = 0;
      for (let yy = -R; yy <= R; yy += step, row++)
        for (let xx = -R; xx <= R; xx += step) {
          const cx = xx + (row % 2 ? step / 2 : 0);
          inner += `<polygon points="${cx},${yy - d} ${cx + d},${yy} ${cx},${yy + d} ${cx - d},${yy}" fill="${light}" opacity="0.5"/>`;
        }
      break;
    }
    default:
      return "";
  }
  return `<g clip-path="url(#${clipId})">${inner}</g>`;
}

// One barrel: a single gray fill with one darker outline (pre-redesign border, no
// dark outer shell / inset core), drawn in the barrel's LOCAL axis-aligned space
// inside a <g> transform (translate perp, rotate angle) — mirroring the Pixi Tank
// renderer so preview and in-world turrets match. Geometry unchanged.
function svgBarrel(b, fillC) {
  const w0 = b.w0 ?? b.width;
  const w1 = b.w1 ?? b.width;
  const s = b.start ?? 0;
  const len = b.length;
  const fill = hexToCss(fillC);
  const edgeC = hexToCss(darken(fillC));
  const trap = Math.abs(w0 - w1) > R * 0.03;
  const edge = 3;

  let inner;
  if (!trap) {
    const r = Math.min(w0 * 0.32, len * 0.3);
    inner = `<rect x="${s.toFixed(1)}" y="${(-w0 / 2).toFixed(1)}" width="${len.toFixed(1)}" height="${w0.toFixed(1)}" rx="${r.toFixed(1)}" fill="${fill}" stroke="${edgeC}" stroke-width="${edge}"/>`;
  } else {
    const pts = [[s, -w0 / 2], [s + len, -w1 / 2], [s + len, w1 / 2], [s, w0 / 2]];
    const fmt = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    inner = `<polygon points="${fmt}" fill="${fill}" stroke="${edgeC}" stroke-width="${edge}" stroke-linejoin="round"/>`;
  }

  const ox = (-Math.sin(b.angle) * b.perp).toFixed(2);
  const oy = (Math.cos(b.angle) * b.perp).toFixed(2);
  const deg = ((b.angle * 180) / Math.PI).toFixed(2);
  return `<g transform="translate(${ox} ${oy}) rotate(${deg})">${inner}</g>`;
}
