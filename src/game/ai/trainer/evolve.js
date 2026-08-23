// Offline evolutionary trainer. Evolves ONLY the behavioural genome (policy
// weights) — never source code or game logic. It runs headless BR sims, scores
// each policy by good Battle-Royale behaviour (placement + survival weigh most;
// kills matter but don't dominate, so it won't breed suicide-rushers), then
// selects / crosses / mutates — WITHIN skill tiers so the population keeps a
// believable spread (beginner → elite) and never all converges to one policy.
//
// This is a DEV/training tool: run it separately (window.__ironTrain), save the
// result, and the live game loads the labelled policies. It never runs during a
// live match.

import { GAME } from "../../../config.js";
import { randomGenome, crossover, mutate, PARAM_KEYS } from "../BotProfile.js";
import { runMatch } from "./sim.js";

const KEY = "ironArena.botPolicies";

// --- fitness --------------------------------------------------------------

// Reward good BR behaviour. Placement + survival dominate; kills/damage help;
// taking damage is a small penalty. A 10-kill bot that dies first scores poorly.
function fitness(r, n) {
  if (!r) return 0;
  const placement = n > 1 ? (n - r.placement) / (n - 1) : 1; // 1 = winner, 0 = first out
  const survival = Math.min(1, r.survival / 70);
  return (
    placement * 1.0 +
    survival * 0.6 +
    r.kills * 0.15 +
    r.damageDealt * 0.0008 -
    r.damageTaken * 0.0003 +
    r.upgrades * 0.05
  );
}

// --- population -----------------------------------------------------------

const tierMid = (i) => {
  const t = GAME.ai.skillTiers[i];
  const lo = i === 0 ? 0 : GAME.ai.skillTiers[i - 1].max;
  return (lo + Math.min(1, t.max)) / 2;
};
const tierBand = (i) => {
  const lo = i === 0 ? 0 : GAME.ai.skillTiers[i - 1].max;
  return [lo, Math.min(1, GAME.ai.skillTiers[i].max)];
};

// Target per-tier counts from the configurable skill distribution.
function tierCounts(population) {
  const tiers = GAME.ai.skillTiers;
  const counts = tiers.map((t) => Math.round((GAME.ai.skillDistribution[t.name] ?? 0) * population));
  let sum = counts.reduce((a, b) => a + b, 0);
  while (sum < population) { counts[0]++; sum++; }
  while (sum > population) { counts[counts.length - 1] = Math.max(0, counts[counts.length - 1] - 1); sum--; }
  return counts;
}

function initPopulation(population) {
  const counts = tierCounts(population);
  const pop = [];
  counts.forEach((n, tier) => {
    for (let i = 0; i < n; i++) {
      const g = randomGenome(tierMid(tier));
      g._tier = tier;
      // Reserve a couple of untouched BEGINNER-baseline archetypes as a floor.
      if (tier === 0 && i < 2) g._baseline = true;
      pop.push(g);
    }
  });
  return pop;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function clampSkillToTier(g) {
  const [lo, hi] = tierBand(g._tier);
  g.skill = clamp01(Math.min(hi - 0.001, Math.max(lo, g.skill)));
  return g;
}

// Tournament pick (mostly within tier; occasionally cross-tier so good behaviour
// spreads). Returns an index into `pop`.
function tournament(pop, fit, tier, rng = 3) {
  const pool = [];
  for (let i = 0; i < pop.length; i++) if (pop[i]._tier === tier) pool.push(i);
  if (Math.random() < 0.15 || pool.length < 2) for (let i = 0; i < pop.length; i++) pool.push(i); // cross-tier splash
  let best = pool[(Math.random() * pool.length) | 0];
  for (let k = 1; k < rng; k++) {
    const c = pool[(Math.random() * pool.length) | 0];
    if (fit[c] > fit[best]) best = c;
  }
  return best;
}

// Build the next generation, tier by tier: keep elites, breed the rest.
function nextGeneration(pop, fit) {
  const counts = tierCounts(pop.length);
  const next = [];
  counts.forEach((n, tier) => {
    const members = pop.map((g, i) => ({ g, i })).filter((x) => x.g._tier === tier).sort((a, b) => fit[b.i] - fit[a.i]);
    // Always carry over reserved beginner baselines untouched.
    const baselines = members.filter((m) => m.g._baseline).map((m) => m.g);
    for (const b of baselines) if (next.filter((x) => x._tier === tier).length < n) next.push(b);
    // Elites: top ~35% of the tier survive as-is.
    const elite = Math.max(1, Math.round(n * 0.35));
    for (let e = 0; e < elite && next.filter((x) => x._tier === tier).length < n; e++) {
      const g = members[e]?.g;
      if (g && !g._baseline) next.push(g);
    }
    // Children fill the rest.
    while (next.filter((x) => x._tier === tier).length < n) {
      const a = pop[tournament(pop, fit, tier)];
      const b = pop[tournament(pop, fit, tier)];
      const child = clampSkillToTier(Object.assign(mutate(crossover(a, b)), { _tier: tier }));
      next.push(child);
    }
  });
  return next;
}

// --- generation stats -----------------------------------------------------

function genStats(gen, pop, fit, aggr) {
  const sorted = [...fit].sort((a, b) => b - a);
  const avg = fit.reduce((a, b) => a + b, 0) / fit.length;
  // Diversity: mean per-param standard deviation across the population.
  let diversity = 0;
  for (const k of PARAM_KEYS) {
    const vals = pop.map((g) => g.params[k]);
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    diversity += Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / vals.length);
  }
  diversity /= PARAM_KEYS.length;
  const n = aggr.count || 1;
  return {
    gen,
    best: +sorted[0].toFixed(3),
    avg: +avg.toFixed(3),
    worst: +sorted[sorted.length - 1].toFixed(3),
    avgPlacement: +(aggr.placement / n).toFixed(2),
    avgSurvival: +(aggr.survival / n).toFixed(1),
    avgKills: +(aggr.kills / n).toFixed(2),
    avgDamage: +(aggr.damage / n).toFixed(0),
    diversity: +diversity.toFixed(3),
  };
}

// --- training loop --------------------------------------------------------

export function train(opts = {}) {
  const population = opts.population ?? 48;
  const generations = opts.generations ?? 8;
  const matchSize = opts.matchSize ?? 16;
  const matchesPerGen = opts.matchesPerGen ?? 8;

  let pop = initPopulation(population);
  const log = [];

  for (let gen = 0; gen < generations; gen++) {
    const scoreSum = new Array(pop.length).fill(0);
    const scoreCnt = new Array(pop.length).fill(0);
    const aggr = { placement: 0, survival: 0, kills: 0, damage: 0, count: 0 };

    for (let m = 0; m < matchesPerGen; m++) {
      // Random subset for this match (ensures broad coverage over the generation).
      const idxs = [];
      const shuffled = [...pop.keys()].sort(() => Math.random() - 0.5).slice(0, matchSize);
      for (const i of shuffled) idxs.push(i);
      const results = runMatch(idxs.map((i) => pop[i]), { maxTime: opts.maxTime ?? 70 });
      results.forEach((r, localIdx) => {
        const gi = idxs[localIdx];
        const f = fitness(r, idxs.length);
        scoreSum[gi] += f;
        scoreCnt[gi]++;
        if (r) {
          aggr.placement += r.placement;
          aggr.survival += r.survival;
          aggr.kills += r.kills;
          aggr.damage += r.damageDealt;
          aggr.count++;
        }
      });
    }

    const fit = pop.map((_, i) => (scoreCnt[i] ? scoreSum[i] / scoreCnt[i] : 0));
    log.push(genStats(gen, pop, fit, aggr));
    if (gen < generations - 1) pop = nextGeneration(pop, fit);
    else savePolicies(pop, fit);
  }

  return { log, population: pop };
}

// --- persistence ----------------------------------------------------------

function cleanGenome(g) {
  return { skill: g.skill, personality: g.personality, styleName: g.styleName, params: { ...g.params }, targetPreference: g.targetPreference, _tier: g._tier };
}

export function savePolicies(pop) {
  const byTier = {};
  for (const g of pop) {
    const name = GAME.ai.skillTiers[g._tier]?.name || "Beginner";
    (byTier[name] ||= []).push(cleanGenome(g));
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(byTier));
  } catch {
    /* storage may be unavailable */
  }
  _cache = byTier; // refresh the in-session cache so live bots use them immediately
  return byTier;
}

let _cache; // loaded policies, cached per session
export function loadPolicies() {
  if (_cache !== undefined) return _cache;
  try {
    _cache = JSON.parse(localStorage.getItem(KEY)) || null;
  } catch {
    _cache = null;
  }
  return _cache;
}

// Sample a saved policy genome by the configurable skill distribution (for the
// live game to assign trained brains). Returns null if none are trained yet.
export function pickSavedPolicy() {
  const policies = loadPolicies();
  if (!policies) return null;
  const tiers = GAME.ai.skillTiers;
  let r = Math.random();
  let acc = 0;
  for (const t of tiers) {
    acc += GAME.ai.skillDistribution[t.name] ?? 0;
    if (r <= acc && policies[t.name]?.length) {
      const list = policies[t.name];
      return list[(Math.random() * list.length) | 0];
    }
  }
  // fallback: any tier that has genomes
  for (const name of Object.keys(policies)) if (policies[name]?.length) return policies[name][(Math.random() * policies[name].length) | 0];
  return null;
}
