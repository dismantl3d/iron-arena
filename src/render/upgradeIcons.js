// Flat, bold, Diep-inspired upgrade glyphs drawn onto a Pixi Graphics, centered
// at (0,0). ONE source of truth so the bottom-left HUD slots and the world
// pickups show the same icon for each upgrade. `s` is the glyph half-size; the
// caller fills/positions a frame (circle / hexagon) around it.

// key: a NORMAL_TYPES key or a SPECIALS key. color: glyph color.
export function drawUpgradeIcon(g, key, color, s = 10) {
  const w = Math.max(2, s * 0.26); // bold stroke
  const stroke = { color, width: w, cap: "round", join: "round" };
  switch (key) {
    // --- normal upgrades ---
    case "bulletSpeed": // a bullet with motion lines
      g.circle(s * 0.35, 0, s * 0.42).fill(color);
      g.moveTo(-s, -s * 0.45).lineTo(-s * 0.1, -s * 0.45).stroke(stroke);
      g.moveTo(-s, 0).lineTo(-s * 0.3, 0).stroke(stroke);
      g.moveTo(-s, s * 0.45).lineTo(-s * 0.1, s * 0.45).stroke(stroke);
      break;
    case "bulletRange": // a long projectile
      g.roundRect(-s, -s * 0.28, s * 1.7, s * 0.56, s * 0.28).fill(color);
      g.poly([s * 0.7, -s * 0.28, s, 0, s * 0.7, s * 0.28]).fill(color);
      break;
    case "reloadSpeed": // circular reload arrows
      g.arc(0, 0, s * 0.7, -Math.PI * 0.85, Math.PI * 0.35).stroke(stroke);
      g.poly([s * 0.55, -s * 0.7, s * 0.95, -s * 0.5, s * 0.5, -s * 0.2]).fill(color);
      break;
    case "tankArmor": // shield
      g.moveTo(0, -s)
        .lineTo(s * 0.85, -s * 0.55)
        .lineTo(s * 0.7, s * 0.5)
        .lineTo(0, s)
        .lineTo(-s * 0.7, s * 0.5)
        .lineTo(-s * 0.85, -s * 0.55)
        .closePath()
        .fill(color);
      break;
    case "moveSpeed": // double chevron
      g.moveTo(-s * 0.8, -s * 0.6).lineTo(-s * 0.1, 0).lineTo(-s * 0.8, s * 0.6).stroke(stroke);
      g.moveTo(-s * 0.1, -s * 0.6).lineTo(s * 0.6, 0).lineTo(-s * 0.1, s * 0.6).stroke(stroke);
      break;

    // --- specials ---
    case "healing": // plus / health cross
      g.roundRect(-s * 0.28, -s * 0.85, s * 0.56, s * 1.7, s * 0.14).fill(color);
      g.roundRect(-s * 0.85, -s * 0.28, s * 1.7, s * 0.56, s * 0.14).fill(color);
      break;
    case "flash": // lightning bolt
      g.moveTo(s * 0.2, -s)
        .lineTo(-s * 0.55, s * 0.15)
        .lineTo(-s * 0.05, s * 0.15)
        .lineTo(-s * 0.3, s)
        .lineTo(s * 0.6, -s * 0.2)
        .lineTo(s * 0.05, -s * 0.2)
        .closePath()
        .fill(color);
      break;
    case "loot": // drone: body + four rotor dots
      g.roundRect(-s * 0.4, -s * 0.4, s * 0.8, s * 0.8, s * 0.16).fill(color);
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        g.circle(dx * s * 0.78, dy * s * 0.78, s * 0.22).fill(color);
        g.moveTo(dx * s * 0.4, dy * s * 0.4).lineTo(dx * s * 0.78, dy * s * 0.78).stroke(stroke);
      }
      break;
    case "sentry": // turret: round base + barrel
      g.circle(0, s * 0.25, s * 0.55).fill(color);
      g.roundRect(-s * 0.18, -s, s * 0.36, s * 0.9, s * 0.1).fill(color);
      break;
    case "radar": // sweep: arc + wedge
      g.arc(0, 0, s * 0.9, -Math.PI / 2, 0).stroke(stroke);
      g.moveTo(0, 0).lineTo(0, -s * 0.9).lineTo(s * 0.64, -s * 0.64).closePath().fill(color);
      g.circle(0, 0, s * 0.16).fill(color);
      break;
    default:
      g.circle(0, 0, s * 0.6).fill(color);
  }
  return g;
}
