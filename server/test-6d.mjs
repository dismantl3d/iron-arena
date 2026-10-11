// Phase 14.2 Step 6d/6e networked test: the FULL authoritative flow over the wire —
// lobby (countdown) → matchStart → live battle royale (guardians, walls, loot crates,
// upgrade pickups, staged fog) → authoritative winner → lobby reset. Verifies multiple
// clients see the SAME world consistently. Spawns its own server (fast settings) so it
// needs no manual setup.  node server/test-6d.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";
import { createSnapshotCache, expandSnapshot } from "../src/net/snapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port, env) {
  const p = spawn(process.execPath, [path.join(__dirname, "index.js")], {
    env: { ...process.env, IRON_DB: 'memory', PORT: String(port), ...env }, stdio: ["ignore", "ignore", "inherit"],
  });
  return p;
}

function client(url, name) {
  const ws = new WebSocket(url);
  const c = { ws, name, id: null, last: null, phase: null, welcome: null, matchStart: null, winner: null, lobbies: 0, kills: [] };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", name, weapon: 0, color: 0 })));
  ws.on("message", (raw) => {
    let m = JSON.parse(raw.toString());
    if (m.t === "state") m = expandSnapshot(m, (ws._cache ||= createSnapshotCache()));
    if (m.t === "welcome") { c.id = m.id; c.welcome = m; c.phase = m.phase; }
    else if (m.t === "state") { c.last = m; if (m.phase) c.phase = m.phase; }
    else if (m.t === "matchStart") { c.matchStart = m; c.phase = "playing"; }
    else if (m.t === "winner") c.winner = m;
    else if (m.t === "kill") c.kills.push(m);
  });
  ws.on("close", () => { c.closed = true; });
  return c;
}
const ents = (c, type) => (c.last?.players || []).filter((p) => (type ? p.type === type : true));
const R = {};

(async () => {
  // ===== PART 1: lobby → matchStart → live BR world (2 humans + bots) =====
  const srv1 = startServer(8091, { MP_COUNTDOWN: "2", MP_SIZE: "8", MP_LOBBY_BOTS: "3" });
  await sleep(800);
  const U = "ws://localhost:8091";
  const A = client(U, "Alice"), B = client(U, "Bob");
  await sleep(600);

  R.welcome_phase_is_waiting = A.welcome?.phase === "waiting";
  R.lobby_countdown_present = typeof A.last?.countdown === "number";
  R.humans_in_lobby = ents(A, "player").length;

  // wait through the countdown into the live match
  await sleep(2500);
  R.matchStart_received = !!A.matchStart && !!B.matchStart;
  R.matchStart_sent_walls = (A.matchStart?.walls || []).length;
  R.phase_now_playing = A.phase === "playing";

  await sleep(1200); // let the live world broadcast
  R.guardians_seen = ents(A, "guardian").length;
  R.crates_seen = (A.last?.crates || []).length;
  R.pickups_seen = (A.last?.pickups || []).length;
  R.fog_in_state = !!A.last?.fog;
  R.roster_size = ents(A, "player").length + ents(A, "bot").length; // humans + bots
  // consistency: A and B see the same guardians at (nearly) the same place
  const gA = ents(A, "guardian")[0];
  const gB = ents(B, "guardian").find((g) => g.id === gA?.id);
  R.guardians_consistent = gA && gB ? Math.hypot(gA.x - gB.x, gA.y - gB.y) < 80 : false;
  R.crates_consistent = JSON.stringify((A.last?.crates || []).map((c) => c.id).sort()) === JSON.stringify((B.last?.crates || []).map((c) => c.id).sort());

  // combat window: both humans fire; accumulate bullet sightings over the window.
  let sawPlayerBullet = false, sawGuardianShell = false;
  const t2 = Date.now() + 5000;
  while (Date.now() < t2) {
    for (const c of [A, B]) {
      const me = (c.last?.players || []).find((p) => p.id === c.id);
      if (me) c.ws.send(JSON.stringify({ t: "input", mx: 0, my: 0, aim: Math.random() * 6.28, fire: true }));
    }
    if ((A.last?.bullets || []).some((b) => !b.g)) sawPlayerBullet = true;
    if ((A.last?.bullets || []).some((b) => b.g === 1)) sawGuardianShell = true;
    await sleep(60);
  }
  R.guardian_shells_in_flight = sawGuardianShell;
  R.player_or_bot_bullets = sawPlayerBullet;
  R.any_kills = A.kills.length > 0 || B.kills.length > 0;

  A.ws.close(); B.ws.close();
  await sleep(200);
  srv1.kill();
  await sleep(400);

  // ===== PART 2: authoritative winner → lobby (solo match: the human is the sole
  // combatant, so the server declares them the winner deterministically) =====
  const srv2 = startServer(8092, { MP_COUNTDOWN: "1", MP_SIZE: "1", MP_LOBBY_BOTS: "1" });
  await sleep(800);
  const H = client("ws://localhost:8092", "Hunter");
  await sleep(2500); // into the match
  R.p2_match_started = H.phase === "playing" || !!H.winner;

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !H.winner) await sleep(50);
  R.winner_announced = !!H.winner;
  R.winner_is_the_human = H.winner?.id === H.id;
  // after the winner, the match ends + cleans up (server closes the socket). No
  // in-place lobby reset in the multi-lobby model — a new PLAY is fresh matchmaking.
  await sleep(7000);
  R.match_ended_and_cleaned_up = H.closed === true;

  H.ws.close();
  srv2.kill();
  await sleep(300);

  console.log(JSON.stringify(R, null, 2));
  process.exit(0);
})();
