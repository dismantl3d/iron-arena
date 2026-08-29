// Headless proof that the AUTHORITATIVE WorldModel runs a complete battle-royale:
// real arena scale, guardians (patrol/fire/kill), walls, staged fog, loot crates +
// upgrade pickups collected through the authoritative system, thinning to a winner.
// Everything the SERVER owns — no Pixi, pure Node.  node this file.

import { WorldModel } from "./WorldModel.js";
import { BotBrain } from "../game/BotBrain.js";
import { makeNameGen } from "../game/ai/names.js";
import { GAME, WORLD } from "../config.js";

const world = new WorldModel({ fog: true, onKill: () => {} });
const nameGen = makeNameGen();
const DT = 1 / 30;

// One human-type entity (exercises player-only contact damage + special pickups)
// plus a roster of bots — all driven by the shared BotBrain for the test.
const human = world.addEntity({ id: "player_001", type: "player", team: "player_001", name: "TestHuman", color: 0, weapon: 0 });
human.ai = new BotBrain(world.aiView(), null);
world.resolveStats("player_001");
for (let i = 0; i < 15; i++) {
  const id = "bot_" + String(i).padStart(2, "0");
  const e = world.addEntity({ id, type: "bot", team: id, name: nameGen(), color: 0 });
  e.ai = new BotBrain(world.aiView(), null);
  world.resolveStats(id);
}

world.beginMatch();

const guardians0 = world._list.filter((e) => e.type === "guardian").length;
const walls0 = world.walls.length;
const pickups0 = world.pickups.length;
const crates0 = world.crates.length;
const fogStart = world.fog.radius;

let guardianFired = false, guardianMoved = false, gPrev = null;
let anyUpgrade = false, crateBroke = false, contactHurt = false;
let humanHpMin = human.maxHp;
let winner = null, frames = 0;

for (let f = 0; f < 30 * 240; f++) { // up to 240 simulated seconds
  frames = f;
  // Drive every alive combatant with its BotBrain (guardians are model-driven).
  for (const e of world._list) {
    if (!e.ai || !e.alive || e.type === "guardian") continue;
    const cmd = e.ai.think(DT, e);
    const mv = cmd.move || { x: 0, y: 0 };
    world.setInput(e.id, { mx: mv.x, my: mv.y, aim: cmd.aim ?? e.rot, fire: e.ai.wantsFire });
  }
  const gd = world._list.find((e) => e.type === "guardian" && e.alive);
  if (gd && gPrev) { if (Math.hypot(gd.x - gPrev.x, gd.y - gPrev.y) > 0.5) guardianMoved = true; }
  if (gd) gPrev = { x: gd.x, y: gd.y };
  const crates1 = world.crates.length;

  world.step(DT);

  if (world.bullets.some((b) => b.guardian)) guardianFired = true;
  if (world.crates.length < crates1) crateBroke = true;
  if (Object.keys(human.upgrades.normals).length || human.upgrades.specials.length) anyUpgrade = true;
  for (const e of world._list) if ((e.type === "bot" || e.type === "player") && Object.keys(e.upgrades.normals).length) anyUpgrade = true;
  if (human.alive) humanHpMin = Math.min(humanHpMin, human.hp);

  const alive = world.aliveCombatants();
  if (alive <= 1) { winner = world._list.find((e) => e.alive && (e.type === "player" || e.type === "bot")); break; }
}

const snap = world.snapshot();
const out = {
  arena_half: world.arena,
  arena_matches_game: world.arena === WORLD.arenaHalf,
  guardians_spawned: guardians0,
  walls_spawned: walls0,
  pickups_spawned: pickups0,
  crates_spawned: crates0,
  guardian_moved: guardianMoved,
  guardian_fired: guardianFired,
  crate_broke_and_scattered: crateBroke,
  upgrades_collected: anyUpgrade,
  fog_start: Math.round(fogStart),
  fog_end: Math.round(world.fog.radius),
  fog_shrank: world.fog.radius < fogStart,
  guardians_alive_at_end: world._list.filter((e) => e.type === "guardian" && e.alive).length,
  resolved_to_winner: !!winner,
  winner: winner ? `${winner.name} (${winner.type})` : null,
  seconds: Math.round(frames / 30),
  snapshot_has: {
    fog: !!snap.fog,
    guardians: snap.players.filter((p) => p.type === "guardian").length,
    crates: snap.crates.length,
    pickups: snap.pickups.length,
    walls_welcome: world.wallData().length,
  },
};
console.log(JSON.stringify(out, null, 2));
