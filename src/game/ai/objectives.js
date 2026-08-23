// Objective selection: pick the single active goal from context + chosen target
// + profile. It's a TACTICAL evaluation, not "enemy → attack": the bot weighs how
// favorable a fight is (HP, numbers, target weakness, range, risk tolerance) and
// can decide to attack, chase, wait/third-party, retreat, or ignore. Kept
// separate from perception, targeting, and execution so each can evolve.

export const OBJ = {
  EXPLORE: "EXPLORE",
  FIND_CRATE: "FIND_CRATE",
  COLLECT_UPGRADE: "COLLECT_UPGRADE",
  ATTACK_ENEMY: "ATTACK_ENEMY",
  CHASE_ENEMY: "CHASE_ENEMY",
  RETREAT: "RETREAT",
  ROTATE_TO_SAFE_ZONE: "ROTATE_TO_SAFE_ZONE",
  FIGHT_GUARDIAN: "FIGHT_GUARDIAN",
  ESCAPE_DANGER: "ESCAPE_DANGER",
  WAIT: "WAIT", // observe a fight / hold for an opening (third-party)
};

// How favorable is engaging `target` right now? ~0 (bad) .. ~1 (great). Weighs HP
// advantage, target weakness, being outnumbered, and the bot's disposition.
export function fightScore(ctx, target, p) {
  const tf = target.hp / target.maxHp;
  let s = 0.5;
  s += (ctx.hpFrac - tf) * 0.5; // my HP vs theirs
  s += (1 - tf) * 0.3; // weak targets are tempting
  s -= Math.min(0.3, Math.max(0, ctx.enemies.length - 1) * 0.1); // outnumbered nearby = risky (capped)
  s += (p.aggression - 0.5) * 0.45;
  s += (p.riskTolerance - 0.5) * 0.3;
  if (ctx.hpFrac < 0.35) s -= 0.2; // low HP makes any fight worse
  return s;
}

export function chooseObjective(ctx, target, profile) {
  const p = profile.params;

  // 1. Toxic fog dominates everything.
  if (ctx.outside) return OBJ.ESCAPE_DANGER;
  const rotateEdge = ctx.safeR * (1.05 - p.fogAwareness * 0.28); // higher awareness rotates earlier
  if (ctx.distCenter > rotateEdge && ctx.phase !== "early") return OBJ.ROTATE_TO_SAFE_ZONE;

  // 2. Low HP near a threat -> break off — UNLESS a near-dead enemy is right there
  //    to finish. Low HP must NOT mean "never take a free kill" (no flat HP rule).
  if (ctx.hpFrac < p.retreatThreshold && (ctx.enemyDist < 750 || ctx.guardianDist < 650)) {
    const killShot = target && target.hp / target.maxHp < 0.22 && ctx.enemyDist < p.preferredRange * 1.3;
    if (!killShot) return OBJ.RETREAT;
  }

  // 2b. Actively taking fire: react (fight back if remotely favorable, else peel).
  if (ctx.underFire && target) {
    const fs = fightScore(ctx, target, p);
    if (fs > 0.4) return ctx.enemyDist > p.preferredRange * 1.25 && p.chaseTendency > 0.4 ? OBJ.CHASE_ENEMY : OBJ.ATTACK_ENEMY;
    return OBJ.RETREAT;
  }

  // 3. Arena Guardian as a risk/reward: finish a weak one, or engage if capable.
  if (ctx.guardian && ctx.guardianDist < 1100 && ctx.hpFrac > 0.5) {
    const finishable = ctx.guardianHpFrac < 0.3;
    const capable =
      profile.personality === "guardianHunter" ? profile.skill > 0.4 : profile.skill > 0.7 && p.riskTolerance > 0.6;
    if (finishable || capable) return OBJ.FIGHT_GUARDIAN;
  }

  // 4. Enemy tanks — a real tactical decision, not reflexive, but the bot MUST
  //    engage favorable / point-blank threats. The goal is to WIN (be last alive),
  //    not to survive passively, so ignoring a reachable enemy is never an option.
  if (target) {
    const tf = target.hp / target.maxHp;
    const weak = tf < 0.45;
    const targetBusy = target._hitTimer > 0; // already trading with someone else
    const fs = fightScore(ctx, target, p);
    const engageRange = p.preferredRange * 1.7 + 200;
    const veryClose = ctx.enemyDist < Math.max(340, p.preferredRange * 0.85);

    // Immediate close-range threat: never ignore an enemy in your face. Fight it
    // unless genuinely losing (low HP AND clearly unfavorable AND they're healthy).
    if (veryClose) {
      if (fs < 0.32 && ctx.hpFrac < 0.5 && !weak) return OBJ.RETREAT;
      return OBJ.ATTACK_ENEMY;
    }

    // Third-party: a patient opportunist watches a busy healthy fight and strikes
    // the weakened side, rather than diving a healthy target it can't beat cleanly.
    if (targetBusy && !weak && ctx.enemyDist < engageRange && p.opportunism > 0.6 && p.patience > 0.5 && ctx.hpFrac > 0.5 && fs < 0.6) {
      return OBJ.WAIT;
    }

    // Phase-scaled willingness to commit (early = a little cautious, late = pushy).
    const phaseAggr = ctx.phase === "early" ? -0.05 : ctx.phase === "late" ? 0.18 : 0.05;
    const commit = (weak || fs + phaseAggr >= 0.45) && ctx.hpFrac > p.retreatThreshold && ctx.enemyDist < engageRange;
    if (commit) {
      return ctx.enemyDist > p.preferredRange * 1.25 && p.chaseTendency > 0.35 ? OBJ.CHASE_ENEMY : OBJ.ATTACK_ENEMY;
    }

    // Close-ish but unfavorable -> peel away instead of trading badly.
    if (ctx.enemyDist < p.preferredRange && fs < 0.32) return OBJ.RETREAT;
  }

  // 5. Loot — only when it's actually WORTH it. The value is build-aware (marginal
  //    stat gain + under-invested categories, computed in ai/loot.js); pursuit then
  //    weighs distance and nearby threat. Bots ignore low-value loot and abandon it
  //    when an enemy is near, but will contest genuinely high-value loot.
  if (ctx.loot && ctx.lootValue > 0.2) {
    const worth = ctx.lootValue;
    const enemyNear = ctx.enemy && ctx.enemyDist < 520;
    const highValue = worth > 0.85;
    const wants = highValue || p.lootPriority > 0.4 || ctx.phase === "early";
    // Don't wander into a nearby threat for mediocre loot; contest high-value loot
    // only while healthy and willing to take the risk.
    const safeEnough = !enemyNear || (highValue && ctx.hpFrac > 0.45 && p.riskTolerance > 0.35);
    if (wants && safeEnough) {
      return ctx.lootKind === "crate" ? OBJ.FIND_CRATE : OBJ.COLLECT_UPGRADE;
    }
  }

  return OBJ.EXPLORE;
}
