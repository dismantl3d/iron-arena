// Shared barrel geometry for weapons, so a weapon's turret looks identical
// whether it's drawn in-world (Pixi, on the Tank) or as a flat SVG preview in
// the Arsenal cards. Returns a list of barrels relative to a tank of radius R,
// each a (possibly trapezoidal / detached) quad pointing along its own `angle`:
//
//   { start, length, w0, w1, perp, angle }
//     start  — how far from center the quad BEGINS (default 0). >0 detaches it
//              from the body, e.g. the Burst muzzle block.
//     length — how far the barrel extends from `start`.
//     w0     — width at the base, w1 — width at the muzzle. w0 !== w1 = trapezoid.
//     perp   — sideways offset from the center axis (side-by-side barrels).
//     angle  — direction in radians (0 = forward).
//
// Geometry only — no colors. Callers pick fills/outlines to match their medium.
// Designs follow the authoritative weapon PDF (Core Weapon Concepts).

export function turretBarrels(turret, R) {
  const bar = (length, w, perp = 0, angle = 0) => ({ start: 0, length: length * R, w0: w * R, w1: w * R, perp: perp * R, angle });
  switch (turret) {
    case "dual": // two standard barrels, small gap, full width
      return [bar(2.2, 0.55, -0.55), bar(2.2, 0.55, 0.55)];
    case "wide": // machine gun — trapezoid: narrow base, flared muzzle
      return [{ start: 0, length: 1.9 * R, w0: 0.5 * R, w1: 1.0 * R, perp: 0, angle: 0 }];
    case "flank": // full standard barrel front AND back
      return [bar(2.1, 0.55, 0, 0), bar(1.7, 0.55, 0, Math.PI)];
    case "long": // sniper — long, standard thickness
      return [bar(3.1, 0.55)];
    case "triple": // three standard barrels angled up / middle / down (a fan)
      return [bar(2.1, 0.5, 0, -0.32), bar(2.2, 0.5, 0, 0), bar(2.1, 0.5, 0, 0.32)];
    case "rocket": // rocketeer — a launcher tube flaring to a wide muzzle
      return [{ start: 0, length: 2.35 * R, w0: 0.85 * R, w1: 1.1 * R, perp: 0, angle: 0 }];
    case "penta": // five-way fan, barrels shrinking from the middle outward
      return [
        bar(2.1, 0.5, 0, 0),
        bar(2.0, 0.42, 0, -0.2),
        bar(2.0, 0.42, 0, 0.2),
        bar(1.9, 0.34, 0, -0.4),
        bar(1.9, 0.34, 0, 0.4),
      ];
    case "burst": // burst rifle — one longish barrel with a detached muzzle block
      return [
        { start: 0, length: 1.95 * R, w0: 0.55 * R, w1: 0.6 * R, perp: 0, angle: 0 },
        { start: 2.15 * R, length: 0.5 * R, w0: 0.72 * R, w1: 0.7 * R, perp: 0, angle: 0 }, // muzzle brake (visual burst cue)
      ];
    case "cannon": // one massive barrel, nearly tank-body wide
      return [{ start: 0, length: 2.1 * R, w0: 1.5 * R, w1: 1.65 * R, perp: 0, angle: 0 }];
    case "laser": // medium thin barrel (heat glow drawn separately)
      return [bar(2.55, 0.42)];
    case "single":
    default:
      return [bar(2.2, 0.6)];
  }
}
