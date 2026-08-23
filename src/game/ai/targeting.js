// Target selection: score the nearby enemy candidates and pick the best one to
// engage, weighted by the bot's profile. This is intentionally separate from
// objective selection so both can grow independently (and be evolved later).
//
// Factors: distance, enemy HP (weak = tempting), and whether pursuing drags the
// bot into the fog (cautious bots avoid it). Every competitor is a valid target —
// there is deliberately NO "human = always attack" bias; the player is scored
// exactly like any other tank.

export function chooseTarget(ctx, tank, profile) {
  if (!ctx.enemies.length) return null;
  const p = profile.params;

  let best = null;
  let bestScore = -Infinity;
  for (const c of ctx.enemies) {
    const t = c.tank;
    const hpFrac = t.hp / t.maxHp;
    let score = 0;

    // Closer targets are easier to commit to.
    score += (1 - Math.min(1, c.dist / 1600)) * 1.2;

    // A point-blank enemy (bot OR human) is an immediate threat — give it a strong
    // pull so a competitor right in our face gets engaged, not overlooked. This is
    // proximity-based, not a "human = target" bias: every tank is scored the same.
    if (c.dist < 360) score += (1 - c.dist / 360) * 1.1;

    // Weakened targets are attractive — more so for "weak"-seeking / aggressive bots.
    const weakPull = p.targetPreference === "weak" ? 1.4 : 0.7;
    score += (1 - hpFrac) * weakPull * (0.5 + p.aggression);

    // Chasing a target that sits outside the safe zone is risky for cautious bots.
    if (Math.hypot(t.x, t.y) > ctx.safeR) score -= (1 - p.riskTolerance);

    // A target that's recently been in combat is more vulnerable (flank it).
    if (t._hitTimer > 0) score += 0.25;

    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}
