// Static world-space grid for spatial reference (diep-style). Lives in the
// world container so it pans/zooms with the camera. Drawn once over a fixed
// span; extend later if the world grows.

import { Graphics } from "pixi.js";
import { COLORS, WORLD } from "../config.js";

export function createGrid(span = 4000) {
  const g = new Graphics();
  const step = WORLD.gridSize;

  for (let x = -span; x <= span; x += step) {
    g.moveTo(x, -span).lineTo(x, span);
  }
  for (let y = -span; y <= span; y += step) {
    g.moveTo(-span, y).lineTo(span, y);
  }
  g.stroke({ color: COLORS.grid, width: 1 });

  return g;
}
