// Developer-only tools for the bot AI (NOT exposed in the normal player UI):
//
//   window.__ironTrain(generations, opts) — run the offline evolutionary trainer,
//       print per-generation stats, and save the evolved policies to localStorage.
//       The live game loads them on the next match. Never runs during live play.
//
//   window.__botDebug(index) — explain WHY a bot made its current decision
//       (HP, weapon style, target, threat, objective, reason, confidence).

import { train } from "./evolve.js";
import { fightScore } from "../objectives.js";
import { GAME } from "../../../config.js";
import { RARITIES } from "../../upgrades.js";

export function installDevTools() {
  if (typeof window === "undefined") return;

  window.__ironTrain = (generations = 8, opts = {}) => {
    console.log("%c[IronArena] Evolutionary training started…", "color:#00b0e9", { generations, ...opts });
    const t0 = performance.now();
    const { log } = train({ generations, ...opts });
    console.table(log);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`%c[IronArena] Training done in ${secs}s — policies saved. Play a match to see the evolved bots.`, "color:#76d672");
    return log;
  };

  window.__botDebug = (index = 0) => explainBot(index);
  window.__botDebugAll = () => {
    const g = window.__game?.game;
    if (!g?.bots) return "no match";
    return g.bots.map((_, i) => explainBot(i, true));
  };

  // Show a bot's BASE (Standard) vs FINAL (post-upgrade) gameplay stats + the
  // upgrades it has collected — for verifying that upgrades actually apply.
  window.__botStats = (index = 0) => showBotStats(index);
}

function showBotStats(index) {
  const g = window.__game?.game;
  const bot = g?.bots?.[index];
  if (!bot) return "no bot at that index / not in a live match";
  const w = GAME.weapons[0]; // Standard baseline
  const base = {
    fireRate: w.cooldown,
    damage: w.shots[0].damage,
    bulletSpeed: w.bulletSpeed,
    bulletLife: w.bulletLife,
    moveSpeed: GAME.player.speed,
    maxHp: GAME.player.maxHp,
    armor: 0,
  };
  const final = {
    fireRate: +bot.fireRate.toFixed(3),
    damage: bot._bulletDamage,
    bulletSpeed: +(+bot._bulletSpeed).toFixed(0),
    bulletLife: +(+bot._bulletLife).toFixed(2),
    moveSpeed: +bot.speed.toFixed(0),
    maxHp: bot.maxHp,
    armor: +(+bot.armor).toFixed(2),
  };
  const table = {};
  for (const k of Object.keys(base)) table[k] = { base: base[k], final: final[k] };
  const ups = Object.entries(bot.upgrades?.normals || {}).map(([k, r]) => `${k} (${RARITIES[r]})`);
  const info = {
    bot: bot.name,
    weapon: "Standard",
    tier: bot.ai?.profile?.tier,
    hp: `${Math.round(bot.hp)}/${bot.maxHp}`,
    upgrades: ups.length ? ups.join(", ") : "none",
  };
  console.log(`%c[BOT #${index}] ${bot.name} — Standard`, "color:#00b0e9;font-weight:bold");
  console.table(table);
  console.table(info);
  return { ...info, base, final };
}

// A readable explanation of a bot's current decision.
function explainBot(index, brief = false) {
  const g = window.__game?.game;
  const bot = g?.bots?.[index];
  if (!bot?.ai?.ctx) return "no bot at that index / not in a live match";
  const ai = bot.ai;
  const ctx = ai.ctx;
  const p = ai.profile;
  const target = ai.target;
  const tf = target ? target.hp / target.maxHp : 1;

  const { reason, confidence } = reasonFor(ai, ctx, target);
  const info = {
    bot: bot.name,
    hp: Math.round(ctx.hpFrac * 100) + "%",
    tier: p.tier,
    skill: +p.skill.toFixed(2),
    personality: p.personality,
    weapon: `${p.style.name} (${p.style.kind})`,
    objective: ai.objective,
    target: target ? `${Math.round(ctx.enemyDist)}px @ ${Math.round(tf * 100)}%hp` : "none",
    guardian: ctx.guardian ? `${Math.round(ctx.guardianDist)}px` : "no",
    loot: ctx.loot ? `${ctx.lootKind} ${Math.round(ctx.lootDist)}px` : "no",
    threat: ctx.incoming ? `dodging (t=${ctx.incoming.time.toFixed(2)}s)` : "clear",
    fog: ctx.distCenter > ctx.safeR * 0.85 ? "high" : "low",
    reason,
    confidence: Math.round(confidence * 100) + "%",
  };
  if (!brief) console.table(info);
  return info;
}

function reasonFor(ai, ctx, target) {
  const p = ai.profile.params;
  switch (ai.objective) {
    case "ATTACK_ENEMY":
    case "CHASE_ENEMY": {
      const fs = target ? fightScore(ctx, target, p) : 0.5;
      return { reason: "Favorable fight — committing to the target.", confidence: Math.min(0.99, Math.max(0.3, fs)) };
    }
    case "WAIT":
      return { reason: "Target is busy fighting; waiting to third-party the weaker side.", confidence: 0.6 + p.opportunism * 0.3 };
    case "RETREAT":
      return { reason: "Unfavorable fight / low HP — disengaging.", confidence: 0.7 };
    case "ESCAPE_DANGER":
      return { reason: "Outside the safe zone — escaping the fog.", confidence: 0.9 };
    case "ROTATE_TO_SAFE_ZONE":
      return { reason: "Fog closing — rotating inward early.", confidence: 0.75 };
    case "FIGHT_GUARDIAN":
      return { reason: "Guardian is beatable / I'm capable — engaging.", confidence: 0.65 };
    case "FIND_CRATE":
    case "COLLECT_UPGRADE":
      return { reason: "No urgent threat — grabbing nearby loot.", confidence: 0.55 + p.lootPriority * 0.3 };
    default:
      return { reason: "Nothing detected nearby — exploring.", confidence: 0.4 };
  }
}
