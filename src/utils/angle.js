// Shared angle math. Stepping a current angle toward a target the *short* way
// around the circle is needed both by the player turret and the bot AI, so it
// lives here instead of being duplicated.

// Step `current` toward `target` (radians) by fraction `t`, taking the shortest
// way around the circle. t is clamped to 1, giving smooth exponential-style turning.
export function approachAngle(current, target, t) {
  let diff = target - current;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // wrap to [-PI, PI]
  return current + diff * Math.min(t, 1);
}
