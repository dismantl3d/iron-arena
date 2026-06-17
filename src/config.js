// Global engine + visual constants. Keep tunable values here, not scattered in code.

export const COLORS = {
  background: 0x1c1c1c,
  grid: 0x2a2a2a,
  tankBody: 0x00b0e9, // diep-style blue
  tankBarrel: 0x999999,
};

// Bold outlines: same hue as the fill but darker, drawn thick.
export const OUTLINE = {
  // multiply a fill color by this to get its outline color
  darken: 0.75,
  width: 4,
};

export const WORLD = {
  gridSize: 64, // px between grid lines
};
