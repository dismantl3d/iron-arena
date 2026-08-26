// Shared VISUAL turret geometry for weapons — the single source of truth for how a
// weapon looks, kept separate from its gameplay stats (config.js `GAME.weapons`).
// The same geometry drives the in-world Pixi tank (entities/Tank) AND the flat SVG
// previews (ui/weaponPreview), so a turret looks identical everywhere.
//
// Each entry is a quad relative to a tank of radius R, pointing along its `angle`:
//
//   { start, length, w0, w1, perp, angle }
//     start  — how far from center the quad BEGINS (default 0). >0 detaches it from
//              the body (e.g. the Burst muzzle block, the Rocketeer collar).
//     length — how far the barrel extends from `start`.
//     w0     — width at the base, w1 — width at the muzzle. w0 !== w1 = trapezoid.
//     perp   — sideways offset from the center axis (side-by-side barrels).
//     angle  — direction in radians (0 = forward).
//
// Renderers derive the two-tone look (dark rounded outer + lighter inset core) from
// these dims. Geometry is authored to match the Core Weapon Concepts PDF — do not
// "clean up" the proportions to be tidier than the reference.

export function turretBarrels(turret, R) {
  // Straight barrel (w0 === w1). perp/angle default to a single forward barrel.
  const bar = (length, w, perp = 0, angle = 0) => ({ start: 0, length: length * R, w0: w * R, w1: w * R, perp: perp * R, angle });
  // Trapezoid barrel (base width w0, muzzle width w1).
  const trap = (length, w0, w1, start = 0, perp = 0, angle = 0) => ({ start: start * R, length: length * R, w0: w0 * R, w1: w1 * R, perp: perp * R, angle });

  switch (turret) {
    case "dual": // two full-width standard barrels stacked with a small gap
      return [bar(2.3, 0.6, -0.5), bar(2.3, 0.6, 0.5)];

    case "wide": // Machine Gun — trapezoid flaring from a narrow base to a wide muzzle
      return [trap(1.95, 0.55, 1.2)];

    case "flank": // full barrel forward + a shorter barrel rearward, colinear (PDF: front longer)
      return [bar(2.45, 0.62, 0, 0), bar(1.6, 0.62, 0, Math.PI)];

    case "long": // Sniper — long, slightly slim precision barrel
      return [bar(3.1, 0.6)];

    case "triple": // three standard barrels fanned ~±22° around a straight middle
      return [bar(2.15, 0.55, 0, -0.38), bar(2.25, 0.55, 0, 0), bar(2.15, 0.55, 0, 0.38)];

    case "rocket": // Rocketeer — a wide central launcher with a stepped base collar
      return [
        trap(0.85, 1.28, 1.28, 0.25), // collar (drawn first / behind → tabs peek out at the base)
        bar(2.5, 0.98), // main launcher tube
      ];

    case "penta": // five-way fan; barrels SHRINK outward, middle drawn last (on top)
      return [
        bar(1.9, 0.4, 0, -0.5), // outer pair (smallest)
        bar(1.9, 0.4, 0, 0.5),
        bar(2.1, 0.48, 0, -0.26), // intermediate pair
        bar(2.1, 0.48, 0, 0.26),
        bar(2.35, 0.56, 0, 0), // middle barrel (largest, on top)
      ];

    case "burst": // Burst Rifle — a slim barrel + a SEPARATED muzzle that flares wider at the tip
      return [
        bar(1.85, 0.55), // slim barrel
        trap(0.62, 0.62, 1.05, 1.92), // detached funnel muzzle (small gap; flares out)
      ];

    case "cannon": // Cannoneer — one massive, heavy barrel (nearly tank-body tall)
      return [trap(2.1, 1.3, 1.4)];

    case "laser": // Laser Rifle — a finned/segmented emitter (3 thin bars); heat + beam drawn separately
      return [bar(2.5, 0.22, -0.3), bar(2.6, 0.24, 0), bar(2.5, 0.22, 0.3)];

    case "single":
    default: // Standard — the chunky centered baseline everything is proportioned against
      return [bar(2.4, 0.82)];
  }
}
