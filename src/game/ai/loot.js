// Bot loot valuation: how USEFUL a pickup is to THIS bot given its current build
// (already-owned upgrades), personality, and the situation — so bots chase what
// actually improves them rather than merely the nearest thing. Build-aware
// (marginal stat gain + under-invested categories) and risk-aware (threat near the
// pickup). Pure numbers — no game-state mutation.

import { RARITY_MUL } from "../upgrades.js";
import { botCanUse } from "./context.js";

const TOP_MUL = RARITY_MUL[RARITY_MUL.length - 1];

// Per-type role weight, nudged by the bot's disposition: offense (reload / bullet
// speed / range) is favoured by aggressive bots; survivability (armor / move) by
// cautious ones. Keeps every type useful, but shapes preferences by personality.
function typeWeight(typeKey, p) {
  const aggr = p.aggression;
  const risk = p.riskTolerance;
  switch (typeKey) {
    case "reloadSpeed": return 1.0 + (aggr - 0.5) * 0.6; // fire faster — offense
    case "bulletSpeed": return 0.85 + (aggr - 0.5) * 0.4; // easier hits / reach
    case "bulletRange": return 0.7 + (aggr - 0.5) * 0.3; // reach
    case "moveSpeed": return 0.9 + (0.5 - risk) * 0.4; // mobility / escape
    case "tankArmor": return 0.85 + (0.5 - risk) * 0.6; // survivability
    default: return 0.8;
  }
}

// Usefulness (~0..1.6) of collecting `pk` for `tank` right now (build-aware).
// `kind` is passed explicitly ("crate"/"pickup") since Crate entities carry no
// `.kind` field — inferring it from the object would mis-score crates as 0.
export function lootValue(pk, tank, profile, kind = pk.kind) {
  if (kind === "crate") {
    // Contents are unknown until it's cracked open — a moderate bundle value,
    // scaled by how much the bot cares about loot.
    return 0.6 + profile.params.lootPriority * 0.35;
  }
  if (kind !== "normal") return 0;
  const p = profile.params;
  const normals = tank.upgrades?.normals || {};
  const owned = normals[pk.typeKey];
  // Actual stat gain from this pickup (new rarity vs current), normalized 0..1.
  const gain = (RARITY_MUL[pk.rarity] - (owned != null ? RARITY_MUL[owned] : 0)) / TOP_MUL;
  if (gain <= 0) return 0; // equal/worse than owned (botCanUse already excludes)
  // Build weakness: value categories the bot has UNDER-invested in vs its strongest.
  let maxInvest = 0.0001;
  for (const k in normals) maxInvest = Math.max(maxInvest, RARITY_MUL[normals[k]]);
  const invest = owned != null ? RARITY_MUL[owned] : 0;
  const weakness = 1 - invest / maxInvest; // ~1 = a category it lacks entirely
  return typeWeight(pk.typeKey, p) * (0.45 + 0.55 * gain) * (0.7 + 0.5 * weakness);
}

// Pick the best-value reachable loot for a bot: the crate/usable-pickup within
// `aware` with the highest (value scaled by travel distance and nearby-enemy risk).
// Returns { loot, kind, dist, value, score } or null. Perception-limited — only
// entities the bot could actually see are considered.
export function pickBestLoot(game, tank, profile, aware) {
  const a2 = aware * aware;
  let best = null;
  const consider = (obj, kind) => {
    if (!obj || obj.dead) return;
    if (kind === "pickup" && (obj.ghost || !botCanUse(obj, tank))) return;
    const dx = obj.x - tank.x;
    const dy = obj.y - tank.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > a2) return;
    const value = lootValue(obj, tank, profile, kind);
    if (value <= 0) return;
    const dist = Math.sqrt(d2);
    // Risk: an enemy sitting on the loot makes it contested/dangerous to grab.
    let risk = 0;
    for (const e of game.bots) {
      if (e === tank || e.dead || e.team === tank.team) continue;
      const ex = e.x - obj.x;
      const ey = e.y - obj.y;
      if (ex * ex + ey * ey < 350 * 350) { risk = 1; break; }
    }
    if (!risk && game.player && !game.player.dead) {
      const px = game.player.x - obj.x;
      const py = game.player.y - obj.y;
      if (px * px + py * py < 350 * 350) risk = 1;
    }
    const score = value / (1 + dist / 700) - risk * 0.35 * (1 - profile.params.riskTolerance);
    if (!best || score > best.score) best = { loot: obj, kind, dist, value, score };
  };
  for (const c of game.crates) consider(c, "crate");
  for (const pk of game.pickups) consider(pk, "pickup");
  return best;
}
