// Headless proof (Phase 14.2 Step 4): the EXISTING bot AI (BotBrain + ai/*) drives
// the authoritative WorldModel with NO browser / NO Pixi. Each bot READS the world
// via world.aiView() to decide intent, then feeds that intent through setInput();
// the WorldModel is the sole authority over movement, firing, projectiles, damage,
// and death. This is exactly the flow the multiplayer server will run.
//
//   BotBrain.think(dt, botEntity)  →  { move, aim } + wantsFire
//        →  WorldModel.setInput(id, intent)  →  WorldModel.step(dt)
//
//   node src/sim/test-bot-ai.mjs

import { WorldModel } from "./WorldModel.js";
import { BotBrain } from "../game/BotBrain.js"; // pure decision layer (no Pixi)

const kills = [];
const world = new WorldModel({
  fog: true, // the AI's perception reads fog.radius for zone-rotation reasoning
  onKill: (e) => kills.push(e),
  // cluster spawns so the bots find each other and actually fight
  spawnPoint: () => { const a = Math.random() * Math.PI * 2, r = 150 + Math.random() * 350; return { x: Math.cos(a) * r, y: Math.sin(a) * r }; },
});

// Create bots as world-model entities and attach the REAL BotBrain to each. Each
// bot gets its own team, so they are mutual enemies (bot-vs-bot combat).
const N = 8;
for (let i = 0; i < N; i++) {
  const e = world.addEntity({ id: "bot_" + i, type: "bot", team: "bot_" + i, name: "Bot" + i });
  e.ai = new BotBrain(world.aiView(), null); // intent producer; reads aiView, never mutates the world
  e.skill = e.ai.skill;
}

// Run ~25s of authoritative simulation at 30 Hz.
const dt = 1 / 30;
let maxBullets = 0, everMoved = 0, everTargeted = 0, everFired = 0;
let totalDamage = 0;
const hpPrev = new Map();
for (const e of world._list) hpPrev.set(e.id, e.hp);

for (let f = 0; f < 30 * 25; f++) {
  // 1) DECISION: each alive bot chooses intent from the authoritative world.
  for (const e of world._list) {
    if (!e.alive) continue;
    const cmd = e.ai.think(dt, e); // reads world via aiView, returns {move, aim}
    const mv = cmd.move || { x: 0, y: 0 };
    // 2) INTENT: fed into the model (the model, not the bot, owns the outcome).
    world.setInput(e.id, { mx: mv.x, my: mv.y, aim: cmd.aim ?? e.rot, fire: e.ai.wantsFire });
    if (Math.hypot(mv.x, mv.y) > 0.01) everMoved++;
    if (e.ai.target) everTargeted++;
    if (e.ai.wantsFire) everFired++;
  }
  // 3) AUTHORITY: the WorldModel simulates movement, firing, bullets, damage, death.
  world.step(dt);

  maxBullets = Math.max(maxBullets, world.bullets.length);
  for (const e of world._list) {
    const prev = hpPrev.get(e.id);
    if (prev != null && e.hp < prev) totalDamage += prev - e.hp;
    hpPrev.set(e.id, e.hp);
  }
}

const alive = world._list.filter((e) => e.alive).length;
console.log(JSON.stringify({
  ran_headless_no_pixi: true,
  bots: N,
  bots_moved: everMoved > 0,
  bots_chose_targets: everTargeted > 0,
  bots_fired: everFired > 0,
  bullets_in_flight_peak: maxBullets,
  total_combat_damage: Math.round(totalDamage),
  deaths: kills.length,
  sample_kill: kills[0] ? `${kills[0].killer} -> ${kills[0].victim}` : null,
  alive_at_end: alive,
  eliminations: N - alive,
}, null, 2));
