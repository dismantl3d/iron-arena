// Step 5 integration test: multiple HUMAN clients + SERVER-SIDE BOTS in one
// authoritative match. Verifies humans see each other, all clients see the SAME
// server-side bots (consistent state), bots move + fight authoritatively, and
// disconnects are clean. Dev-only.  (Run the server first: npm run server)
import WebSocket from "ws";

const URL = "ws://localhost:8080";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const ws = new WebSocket(URL);
  const c = { ws, name, id: null, last: null, kills: [] };
  ws.on("open", () => ws.send(JSON.stringify({ t: "join", name })));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "welcome") c.id = m.id;
    else if (m.t === "state") c.last = m;
    else if (m.t === "kill") c.kills.push(m);
  });
  return c;
}
const ents = (c, type) => (c.last?.players || []).filter((p) => (type ? p.type === type : true));

const R = {};
(async () => {
  // ---- connect 4 humans ----
  const A = client("Alice"), B = client("Bob"), C = client("Cara"), D = client("Dan");
  const clients = [A, B, C, D];
  await sleep(700);

  R.human_ids = clients.map((c) => c.id);
  R.unique_human_ids = new Set(clients.map((c) => c.id)).size === 4;
  R.A_sees_all_humans = ents(A, "player").length >= 4;

  // ---- server-side bots present + seen by ALL clients with the SAME ids ----
  const botIds = (c) => ents(c, "bot").map((b) => b.id).sort();
  R.bots_on_server = botIds(A).length;
  R.all_clients_see_same_bots = clients.every((c) => JSON.stringify(botIds(c)) === JSON.stringify(botIds(A)));

  // ---- bot state CONSISTENCY across clients (same positions, ±interp jitter) ----
  const botA = ents(A, "bot")[0];
  const botOnB = ents(B, "bot").find((b) => b.id === botA.id);
  R.same_bot_pos_across_clients = botOnB ? Math.hypot(botA.x - botOnB.x, botA.y - botOnB.y) < 60 : false;

  // ---- bots MOVE + FIGHT authoritatively ----
  const pos0 = ents(A, "bot").map((b) => ({ id: b.id, x: b.x, y: b.y }));
  await sleep(1800);
  const movedBots = ents(A, "bot").filter((b) => { const o = pos0.find((p) => p.id === b.id); return o && Math.hypot(b.x - o.x, b.y - o.y) > 4; }).length;
  R.bots_moved = movedBots;
  R.bot_bullets_in_flight = (A.last?.bullets || []).filter((bl) => String(bl.owner).startsWith("bot")).length;
  R.bot_hp_varies = new Set(ents(A, "bot").map((b) => b.hp)).size > 1; // damage happening
  R.any_kill_events = clients.some((c) => c.kills.length > 0);

  // ---- disconnect: D leaves, others stay stable ----
  D.ws.close();
  await sleep(500);
  R.D_removed_for_A = !(A.last?.players || []).some((p) => p.id === D.id);
  R.A_still_getting_state = !!A.last;
  R.humans_after_disconnect = ents(A, "player").length;

  console.log(JSON.stringify(R, null, 2));
  [A, B, C].forEach((c) => c.ws.close());
  await sleep(100);
  process.exit(0);
})();
