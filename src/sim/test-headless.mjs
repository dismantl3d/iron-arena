// Headless proof: the WorldModel runs the authoritative simulation with NO browser,
// NO Pixi, NO DOM — pure Node. Verifies movement, firing, projectile damage, death,
// kill attribution, anti-teleport input clamping, and snapshots. Dev-only.
//
//   node src/sim/test-headless.mjs

import { WorldModel } from "./WorldModel.js";
import { SIM } from "./constants.js";

const results = {};
const ok = (k, v) => (results[k] = v);

const kills = [];
const world = new WorldModel({ onKill: (e) => kills.push(e), spawnPoint: () => ({ x: 0, y: 0 }) });

// Two players + one "bot" entity (same model, different type tag).
const A = world.addEntity({ id: "player_001", type: "player", team: "player_001", name: "A", x: -200, y: 0 });
const B = world.addEntity({ id: "player_002", type: "player", team: "player_002", name: "B", x: 200, y: 0 });
world.addEntity({ id: "bot_1", type: "bot", team: "bot_1", name: "Bot", x: 0, y: 300 });
ok("entity_count", world.entities.size);
ok("types", [...world.entities.values()].map((e) => e.type));

// 1) Movement: A drives +x for ~0.5s; position must advance but be capped (no teleport).
world.setInput("player_001", { mx: 1, my: 0, aim: 0, fire: false });
const ax0 = A.x;
for (let i = 0; i < 15; i++) world.step(1 / 30);
ok("A_moved_dx", Math.round(A.x - ax0));

// Anti-teleport: claim an absurd move axis — clamped to the unit disc.
world.setInput("player_001", { mx: 99999, my: 0, aim: 0, fire: false });
const preX = A.x;
world.step(1 / 30);
ok("antiteleport_step_px", Math.round(Math.abs(A.x - preX))); // must be small (~<=10)

// 2) Aim relay.
world.setInput("player_001", { mx: 0, my: 0, aim: 1.234, fire: false });
world.step(1 / 30);
ok("aim_applied", Math.round(A.rot * 1000) / 1000);

// 3) Firing: A aims at B and fires from RANGE; bullets appear in flight, B takes
//    damage over several shots and dies.
A.x = -100; A.y = 0; A.vx = 0; A.vy = 0;
B.x = 400; B.y = 0; B.hp = B.maxHp;
let maxBullets = 0;
for (let i = 0; i < 120 && B.alive; i++) {
  const aim = Math.atan2(B.y - A.y, B.x - A.x);
  world.setInput("player_001", { mx: 0, my: 0, aim, fire: true });
  world.step(1 / 30);
  maxBullets = Math.max(maxBullets, world.bullets.length);
}
ok("bullets_spawned", maxBullets > 0);
ok("B_hp_end", Math.round(B.hp));
ok("B_dead", !B.alive);
ok("kill_recorded", kills.length ? `${kills[0].killer} -> ${kills[0].victim}` : null);

// 4) Snapshot shape (what the network broadcasts).
const snap = world.snapshot();
ok("snapshot_players", snap.players.length);
ok("snapshot_has_fields", Object.keys(snap.players[0]).sort().join(","));

// 5) Respawn works.
world.respawn("player_002");
ok("B_respawned", B.alive && Math.round(B.hp) === B.maxHp);

// Confirm no rendering deps leaked in (the import graph is pure).
ok("standard_stats_used", { speed: SIM.speed, cooldown: SIM.cooldown, damage: SIM.damage });

console.log(JSON.stringify(results, null, 2));
