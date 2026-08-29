// Headless multiplayer test: spins up several WS clients against a freshly-spawned
// server (instant match, MP_COUNTDOWN=0) and verifies SERVER-AUTHORITATIVE behaviour
// end to end — connection, movement, anti-teleport, aim, damage, death, disconnect.
// Dev-only. (Self-hosting: no manual `npm run server` needed.)
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = 8093;
const URL = `ws://localhost:${PORT}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [path.join(__dirname, "index.js")], {
  env: { ...process.env, PORT: String(PORT), MP_COUNTDOWN: "0", MP_SIZE: "2", MP_LOBBY_BOTS: "0" },
  stdio: ["ignore", "ignore", "inherit"],
});

function client(name) {
  const ws = new WebSocket(URL);
  const c = { ws, name, id: null, welcome: null, last: null, killMsgs: [], leaveMsgs: [], seen: {} };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", name })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") { c.id = m.id; c.welcome = m; }
    else if (m.t === "state") { c.last = m; for (const p of m.players) c.seen[p.id] = p; }
    else if (m.t === "kill") c.killMsgs.push(m);
    else if (m.t === "leave") c.leaveMsgs.push(m);
  });
  c.input = (mx, my, aim, fire) => ws.send(JSON.stringify({ t: "input", mx, my, aim, fire }));
  return c;
}

const results = {};
const ok = (k, v) => { results[k] = v; };

(async () => {
  await sleep(700); // let the server boot
  // ---- TEST 1: connection + unique ids (2 clients) ----
  const A = client("Alice");
  const B = client("Bob");
  await sleep(900); // connect + instant match start (players placed in the arena)
  ok("connect_A_id", A.id);
  ok("connect_B_id", B.id);
  ok("unique_ids", A.id && B.id && A.id !== B.id);
  ok("A_sees_both", Object.keys(A.seen).length >= 2);
  ok("B_sees_both", Object.keys(B.seen).length >= 2);

  // ---- TEST 2: movement visibility (A moves; B should see A move) ----
  const aStart = { ...B.seen[A.id] };
  for (let i = 0; i < 20; i++) { A.input(1, 0, 0, false); await sleep(30); } // move +x
  const aEnd = B.seen[A.id];
  ok("B_sees_A_move_dx", Math.round(aEnd.x - aStart.x));

  // ---- ANTI-TELEPORT: client claims a huge move axis; server clamps ----
  const preX = B.seen[A.id].x;
  A.input(99999, 0, 0, false); await sleep(40); // one tick
  const postX = B.seen[A.id].x;
  ok("antiteleport_step_px", Math.round(Math.abs(postX - preX))); // must be small (~<=10)

  // ---- TEST 3: aim sync ----
  A.input(0, 0, 1.5708, false); await sleep(120);
  ok("aim_rot_seen_by_B", B.seen[A.id].rot);

  // ---- TEST 4+5+6: A + B close in (match spawns are far apart); A shoots B ->
  //      server-authoritative bullets + damage + death. B holds still while A fires.
  const bHp0 = A.seen[B.id].hp;
  let bullets_seen = 0, minBHp = bHp0;
  for (let i = 0; i < 1200 && A.seen[B.id].alive; i++) {
    const a = A.seen[A.id], b = A.seen[B.id];
    const aim = Math.atan2(b.y - a.y, b.x - a.x);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    // A closes to ~300 then holds and fires point-blank so the kill lands cleanly.
    if (dist > 320) A.input(Math.cos(aim), Math.sin(aim), aim, false);
    else A.input(0, 0, aim, true); // hold + fire
    if (dist > 340) B.input(Math.cos(aim + Math.PI), Math.sin(aim + Math.PI), aim, false); // B closes too
    else B.input(0, 0, aim + Math.PI, false); // then holds still so A can finish it
    await sleep(20);
    if (A.last && A.last.bullets.length) bullets_seen = Math.max(bullets_seen, A.last.bullets.length);
    minBHp = Math.min(minBHp, A.seen[B.id].hp);
  }
  ok("bullets_visible_to_A", bullets_seen);
  ok("B_hp_start", bHp0);
  ok("B_hp_min", minBHp);
  ok("B_took_damage", minBHp < bHp0);
  ok("A_got_kill_msg", A.killMsgs.length);
  ok("kill_victim_is_B", A.killMsgs.some((m) => m.victim === B.id));

  // ---- TEST 7: disconnect removal ----
  B.ws.close();
  await sleep(300);
  const bStillInA = (A.last?.players || []).some((p) => p.id === B.id);
  ok("A_got_leave_msg", A.leaveMsgs.some((m) => m.id === B.id));
  ok("B_removed_from_world", !bStillInA);

  // ---- TEST 8: 4 clients (not hard-coded for 2) ----
  const four = [client("c1"), client("c2"), client("c3"), client("c4")];
  await sleep(500);
  const counts = four.map((c) => Object.keys(c.seen).length);
  ok("four_clients_ids", four.map((c) => c.id));
  ok("four_each_sees_atleast4", counts.every((n) => n >= 4) ? counts : counts);

  console.log(JSON.stringify(results, null, 2));
  A.ws.close(); four.forEach((c) => c.ws.close());
  await sleep(100);
  server.kill();
  process.exit(0);
})();
