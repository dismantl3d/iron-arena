// Multi-lobby matchmaking test: multiple independent matches, capacity-based lobby
// assignment, no joining a match that's already playing, and cross-lobby isolation.
// Spawns its own server.  node server/test-lobbies.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 8110;
const R = {};
const eq = (k, got, want) => { R[k] = got === want ? true : `EXPECTED ${JSON.stringify(want)} GOT ${JSON.stringify(got)}`; };
const truthy = (k, v) => { R[k] = v ? true : `EXPECTED truthy GOT ${JSON.stringify(v)}`; };

// Small lobbies (cap 2 humans) + short countdown so we exercise multi-lobby quickly.
const server = spawn(process.execPath, [path.join(__dirname, "index.js")], {
  env: { ...process.env, IRON_DB: "memory", PORT: String(PORT), MP_COUNTDOWN: "2", MP_SIZE: "2", MP_LOBBY_BOTS: "0" },
  stdio: ["ignore", "ignore", "inherit"],
});

function client(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const c = { ws, name, welcome: null, matchStart: null, last: null };
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "authOk") ws.send(JSON.stringify({ t: "join", name, weapon: 0 }));
    else if (m.t === "welcome") c.welcome = m;
    else if (m.t === "matchStart") c.matchStart = m;
    else if (m.t === "state") c.last = m;
  });
  ws.on("open", () => ws.send(JSON.stringify({ t: "auth", name })));
  return c;
}
const humanIds = (c) => (c.last?.players || []).filter((p) => p.type === "player").map((p) => p.id).sort();

(async () => {
  await sleep(700);

  // ---- Scenario 5: two groups → two independent lobbies (cap 2 each) ----
  const A = client("A"), B = client("B"); // group 1 → lobby X
  await sleep(500);
  const C = client("C"), D = client("D"); // group 2 → lobby Y (X is full at 2)
  await sleep(600);

  const lx = A.welcome?.lobby;
  eq("A_B_same_lobby", B.welcome?.lobby, lx);
  const ly = C.welcome?.lobby;
  eq("C_D_same_lobby", D.welcome?.lobby, ly);
  truthy("two_distinct_lobbies", lx && ly && lx !== ly);

  // isolation: A's world shows only its own lobbymates, never C/D.
  await sleep(400);
  const aIds = humanIds(A);
  R._A_sees = aIds;
  truthy("A_sees_only_its_lobby", aIds.length === 2 && !aIds.includes(C.welcome.id) && !aIds.includes(D.welcome.id));
  const cIds = humanIds(C);
  truthy("C_sees_only_its_lobby", cIds.length === 2 && !cIds.includes(A.welcome.id));

  // ---- Scenario 4: a NEW player never joins a match that's already PLAYING ----
  // Let A/B's lobby (X) reach its match (countdown 2s already elapsed above).
  await sleep(1600);
  R._X_playing = A.matchStart ? "playing" : "not-yet";
  const E = client("E"); // joins while X (and Y) are playing → must get a fresh lobby
  await sleep(700);
  truthy("late_player_not_in_playing_lobby", E.welcome && E.welcome.lobby !== lx && E.welcome.lobby !== ly);
  eq("late_player_new_lobby_waiting", E.welcome?.phase, "waiting");

  for (const c of [A, B, C, D, E]) c.ws.close();
  await sleep(200);
  server.kill();
  console.log(JSON.stringify(R, null, 2));
  const failed = Object.entries(R).filter(([k, v]) => v !== true && !k.startsWith("_"));
  if (failed.length) { console.log("\nFAILURES:", failed.map(([k]) => k).join(", ")); process.exit(1); }
  console.log("\nALL LOBBY TESTS PASSED");
  process.exit(0);
})();
