// A bot's PROFILE: its skill, personality, weapon-style, and the behavioural
// "genome" (numeric params) that drives decisions. Kept as plain tunable numbers
// so the evolutionary trainer can crossover/mutate them WITHOUT touching AI logic.
//
//   skill        — continuous 0..1 execution quality (aim/reaction/prediction).
//   personality  — which priorities the bot leans toward.
//   style        — weapon flavour { name, range, kind } driving positioning.
//   params       — the evolvable behavioural genome (see PARAM_KEYS).

import { GAME } from "../../config.js";

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// The numeric behavioural genome — everything the evolutionary trainer tunes.
// (preferredRange is stored 0..1 and mapped to px by the style; see mapRange.)
export const PARAM_KEYS = [
  "aggression",
  "riskTolerance",
  "lootPriority",
  "retreatThreshold",
  "aimAccuracy",
  "reactionTime",
  "fogAwareness",
  "wanderiness",
  "patience",
  "opportunism",
  "chaseTendency",
  "dodgeTendency",
  "objectivePersistence",
];

// Weapon-style flavour: preferred distance + a positioning KIND used by the
// executor. (Stand-in for a bot's "equipped weapon".)
//   kite      — hold long range, back off when crowded (Sniper/Cannon/Rocketeer)
//   push      — pressure at medium range, move while firing (Machine Gun/Laser)
//   circle    — orbit the target (Flank)
//   poke      — close in, short bursts, disengage (Standard/Burst)
export const WEAPON_STYLES = [
  { name: "standard", range: 340, kind: "poke" },
  { name: "sniper", range: 760, kind: "kite" },
  { name: "machinegun", range: 260, kind: "push" },
  { name: "flank", range: 360, kind: "circle" },
  { name: "rocketeer", range: 520, kind: "kite" },
  { name: "laser", range: 520, kind: "push" },
  { name: "cannoneer", range: 460, kind: "kite" },
  { name: "burst", range: 320, kind: "poke" },
];
const styleByName = (n) => WEAPON_STYLES.find((s) => s.name === n) || WEAPON_STYLES[0];

// --- skill tiers ----------------------------------------------------------

export function tierFor(skill) {
  for (const t of GAME.ai.skillTiers) if (skill <= t.max) return t.name;
  return GAME.ai.skillTiers[GAME.ai.skillTiers.length - 1].name;
}

export function tierIndex(skill) {
  return Math.max(0, GAME.ai.skillTiers.findIndex((t) => t.name === tierFor(skill)));
}

function tierFloor(tier) {
  const tiers = GAME.ai.skillTiers;
  const i = tiers.indexOf(tier);
  return i <= 0 ? 0 : tiers[i - 1].max;
}

// Sample a skill from the configurable population distribution.
export function sampleSkill() {
  const dist = GAME.ai.skillDistribution;
  const tiers = GAME.ai.skillTiers;
  let r = Math.random();
  let acc = 0;
  for (const t of tiers) {
    acc += dist[t.name] ?? 0;
    if (r <= acc) return rand(tierFloor(t), Math.min(1, t.max));
  }
  return rand(tierFloor(tiers[tiers.length - 1]), 1);
}

// --- genomes --------------------------------------------------------------

const PERSONALITY_BASE = {
  hunter: { aggression: 0.9, lootPriority: 0.25, riskTolerance: 0.75, retreat: 0.18, targetPref: "weak", opportunism: 0.4, patience: 0.25, chase: 0.85 },
  scavenger: { aggression: 0.3, lootPriority: 0.95, riskTolerance: 0.35, retreat: 0.36, targetPref: "close", opportunism: 0.5, patience: 0.55, chase: 0.25 },
  survivor: { aggression: 0.2, lootPriority: 0.4, riskTolerance: 0.2, retreat: 0.45, targetPref: "close", opportunism: 0.35, patience: 0.8, chase: 0.15 },
  guardianHunter: { aggression: 0.7, lootPriority: 0.3, riskTolerance: 0.7, retreat: 0.28, targetPref: "weak", opportunism: 0.55, patience: 0.4, chase: 0.6 },
  explorer: { aggression: 0.45, lootPriority: 0.6, riskTolerance: 0.5, retreat: 0.3, targetPref: "close", opportunism: 0.6, patience: 0.5, chase: 0.4 },
  opportunist: { aggression: 0.55, lootPriority: 0.45, riskTolerance: 0.5, retreat: 0.34, targetPref: "weak", opportunism: 0.95, patience: 0.85, chase: 0.5 },
};

// A raw random genome (skill + personality + style + numeric params). `skillHint`
// pins the skill band (used to seed tiered training populations).
export function randomGenome(skillHint = null) {
  const skill = skillHint == null ? sampleSkill() : clamp01(skillHint + rand(-0.05, 0.05));
  const personality = pick(Object.keys(PERSONALITY_BASE));
  const base = PERSONALITY_BASE[personality];
  const j = (v, amt = 0.14) => clamp01(v + rand(-amt, amt));
  return {
    skill,
    personality,
    styleName: pick(WEAPON_STYLES).name,
    params: {
      aggression: j(base.aggression),
      riskTolerance: j(base.riskTolerance),
      lootPriority: j(base.lootPriority),
      retreatThreshold: clamp01(base.retreat + rand(-0.06, 0.06)),
      aimAccuracy: clamp01(0.3 + skill * 0.6 + rand(-0.08, 0.08)),
      reactionTime: clamp01(0.75 - skill * 0.55 + rand(-0.08, 0.08)), // 0..1 (lower = faster)
      fogAwareness: clamp01(0.4 + skill * 0.55 + rand(-0.05, 0.05)),
      wanderiness: clamp01(0.7 - base.aggression * 0.4 + rand(-0.1, 0.1)),
      patience: j(base.patience),
      opportunism: j(base.opportunism),
      chaseTendency: j(base.chase),
      dodgeTendency: clamp01(0.2 + skill * 0.6 + rand(-0.1, 0.1)),
      objectivePersistence: j(0.5),
    },
    targetPreference: base.targetPref,
  };
}

// Turn a genome into the runtime PROFILE the AI reads (maps 0..1 params to the
// concrete numbers the executor uses).
export function profileFromGenome(g) {
  const style = styleByName(g.styleName);
  return {
    skill: clamp01(g.skill),
    tier: tierFor(g.skill),
    personality: g.personality,
    style,
    genome: g, // keep the source genome for debugging / re-breeding
    params: {
      ...g.params,
      // concrete executor values derived from the 0..1 genome:
      reactionTime: 0.1 + g.params.reactionTime * 0.5, // seconds
      preferredRange: style.range, // px, from the weapon style
      targetPreference: g.targetPreference || "close",
    },
  };
}

// Build a bot profile. With no arg -> a fresh random genome; with a saved genome
// (evolved policy) -> that exact policy.
export function makeProfile(genome = null) {
  return profileFromGenome(genome || randomGenome());
}

// --- genetic operators (used by the trainer) ------------------------------

// Uniform-ish crossover: each numeric param is a weighted blend of both parents;
// categorical traits (personality/style/targetPref) are inherited from one.
export function crossover(a, b) {
  const params = {};
  for (const k of PARAM_KEYS) {
    const w = rand(0.35, 0.65);
    params[k] = clamp01(a.params[k] * w + b.params[k] * (1 - w));
  }
  const src = Math.random() < 0.5 ? a : b;
  return {
    skill: clamp01((a.skill + b.skill) / 2 + rand(-0.03, 0.03)),
    personality: (Math.random() < 0.5 ? a : b).personality,
    styleName: (Math.random() < 0.5 ? a : b).styleName,
    params,
    targetPreference: src.targetPreference,
  };
}

// Small random mutations (occasionally larger to keep diversity). Stays in range.
export function mutate(g, rate = 0.25, amount = 0.08) {
  const params = { ...g.params };
  for (const k of PARAM_KEYS) {
    if (Math.random() < rate) {
      const big = Math.random() < 0.12 ? 3 : 1; // occasional larger jump
      params[k] = clamp01(params[k] + rand(-amount, amount) * big);
    }
  }
  let skill = g.skill;
  if (Math.random() < rate) skill = clamp01(skill + rand(-amount, amount));
  let styleName = g.styleName;
  if (Math.random() < 0.06) styleName = pick(WEAPON_STYLES).name; // rare style flip
  let personality = g.personality;
  if (Math.random() < 0.05) personality = pick(Object.keys(PERSONALITY_BASE));
  return { skill, personality, styleName, params, targetPreference: g.targetPreference };
}
