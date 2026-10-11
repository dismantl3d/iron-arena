// A single authoritative Battle Royale lobby → match. Each Match owns its OWN
// isolated world (its own WorldModel, players, bots, bullets, loot, crates,
// guardians, fog, countdown, winner) so multiple matches run simultaneously without
// affecting one another. The server (index.js) is a thin shell: it authenticates
// sockets, matchmakes them into a Match, routes their input, and ticks every Match.
//
// Lifecycle:  waiting (15s countdown, humans may join) → playing (roster topped up
// to matchSize with bots) → winner → ended (cleaned up). A player NEVER joins a
// match that is already playing (index.js only routes joins to WAITING lobbies).

import { WorldModel } from "../src/sim/WorldModel.js";
import { BotBrain } from "../src/game/BotBrain.js"; // existing bot AI (no Pixi/DOM)
import { makeNameGen } from "../src/game/ai/names.js";
import { earnedXp } from "../src/game/IronPath.js"; // existing match-XP formula

// Globally-unique ids across ALL matches (ids double as network keys + log labels).
let seqLobby = 0;
let seqPlayer = 0;
let seqBot = 0;

const idx = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const sendWs = (ws, obj) => { if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch { /* gone */ } } };

export class Match {
  // cfg: { MATCH_SIZE, COUNTDOWN, WINNER_HOLD, WAITING_BOTS, TICK }
  constructor(accounts, cfg) {
    this.id = "lobby_" + String(++seqLobby).padStart(3, "0");
    this.accounts = accounts;
    this.cfg = cfg;
    this.state = "waiting"; // waiting | playing | winner | ended
    this.countdown = cfg.COUNTDOWN;
    this.countdownStarted = false;
    this.winnerHold = 0;
    this.members = new Map(); // playerEntityId -> ws
    this.deadAt = new Map();
    this._nameGen = makeNameGen(); // unique bot names within THIS lobby
    this.world = new WorldModel({ fog: true, onKill: (ev) => this.#onKill(ev) });
    this.createdAt = Date.now();
  }

  // --- membership / matchmaking -------------------------------------------
  get humanCount() { let n = 0; for (const e of this.world._list) if (e.type === "player") n++; return n; }
  aliveBots() { let n = 0; for (const e of this.world._list) if (e.type === "bot" && e.alive) n++; return n; }

  // A new human may only join a WAITING lobby that isn't already at capacity.
  canJoin() { return this.state === "waiting" && this.humanCount < this.cfg.MATCH_SIZE; }
  isEmpty() { return this.members.size === 0; }

  // Add a human to this waiting lobby. Validates the requested loadout against the
  // account (unowned item -> default). Returns the welcome payload fields.
  addPlayer(ws, account, req) {
    const id = "player_" + String(++seqPlayer).padStart(4, "0");
    const name = account.displayName || "Unnamed Tank";
    const e = this.world.addEntity({ id, type: "player", team: id, name, color: 0 });
    const applied = this.accounts.setLoadout(account, { weapon: idx(req.weapon), cosmetic: idx(req.color), wrap: idx(req.wrap), trail: idx(req.trail), killFx: idx(req.killFx), title: idx(req.title) });
    e.color = applied.cosmetic; e.wrap = applied.wrap; e.trail = applied.trail;
    e.killFx = applied.killFx; e.title = applied.title; e.weapon = applied.weapon;
    e.accountId = account.id;
    this.world.resolveStats(id);
    this.members.set(id, ws);
    // The 15s countdown starts as soon as the first human enters this fresh lobby.
    if (!this.countdownStarted) { this.countdownStarted = true; this.countdown = this.cfg.COUNTDOWN; }
    this.#refillLobbyBots();
    return { id, applied };
  }

  removePlayer(id) {
    const e = this.world.get(id);
    // A player leaving mid-match keeps the XP/stats they already earned.
    if (e && e.type === "player" && e.alive && this.state === "playing") this.#awardMatchXp(id, false);
    if (this.world.removeEntity(id)) {
      this.members.delete(id);
      this.deadAt.delete(id);
      this.#broadcast({ t: "leave", id });
    }
  }

  input(id, msg) {
    const e = this.world.get(id);
    if (!e) return;
    if (typeof msg.seq === "number") e._ack = msg.seq; // latest processed input seq
    this.world.setInput(id, { mx: msg.mx, my: msg.my, aim: msg.aim, fire: msg.fire, detonate: msg.detonate });
  }

  // --- welcome / snapshot meta --------------------------------------------
  wallData() { return this.world.wallData(); }

  // --- bots ----------------------------------------------------------------
  #spawnBot() {
    const id = "bot_" + String(++seqBot).padStart(4, "0");
    const e = this.world.addEntity({ id, type: "bot", team: id, name: this._nameGen(), color: 0 });
    e.ai = new BotBrain(this.world.aiView(), null); // existing AI, fresh genome
    e.skill = e.ai.skill;
    this.world.resolveStats(id);
    return e;
  }
  #refillLobbyBots() {
    for (const e of this.world._list) { if (this.aliveBots() >= this.cfg.WAITING_BOTS) break; if (e.type === "bot" && !e.alive) this.world.respawn(e.id); }
    while (this.aliveBots() < this.cfg.WAITING_BOTS) this.#spawnBot();
  }
  // Fill remaining slots so humans + bots == MATCH_SIZE (reuse dead bots, then spawn),
  // trimming any surplus. Uses the EXISTING bot implementation (no MP-only bot AI).
  #fillMatchRoster() {
    const target = Math.max(0, this.cfg.MATCH_SIZE - this.humanCount);
    for (const e of this.world._list) { if (this.aliveBots() >= target) break; if (e.type === "bot" && !e.alive) this.world.respawn(e.id); }
    while (this.aliveBots() < target) this.#spawnBot();
    let surplus = this.aliveBots() - target;
    for (const e of [...this.world._list]) { if (surplus <= 0) break; if (e.type === "bot") { this.world.removeEntity(e.id); surplus--; } }
  }
  #driveBots() {
    for (const e of this.world._list) {
      if (e.type !== "bot" || !e.ai || !e.alive) continue;
      const cmd = e.ai.think(this.cfg.DT, e);
      const mv = cmd.move || { x: 0, y: 0 };
      this.world.setInput(e.id, { mx: mv.x, my: mv.y, aim: cmd.aim ?? e.rot, fire: e.ai.wantsFire });
    }
  }

  // --- lifecycle -----------------------------------------------------------
  #startMatch() {
    this.#fillMatchRoster();
    this.world.beginMatch(); // real arena, guardians, walls, loot, fog reset
    for (const e of this.world._list) if (e.type === "player") { e._matchStart = Date.now(); e._matchKills = 0; e._matchAwarded = false; }
    this.state = "playing";
    this.#broadcast({ t: "matchStart", arena: this.world.arena, walls: this.wallData() });
    console.log(`[iron-arena] ${this.id} match started — ${this.humanCount} human(s) + ${this.aliveBots()} bot(s)`);
  }

  // One authoritative step. Returns false when the match is finished and should be
  // removed by the caller (its sockets are already closed here).
  step(dt) {
    // Reap an empty lobby / abandoned match (no connected members) — no stale matches.
    if (this.isEmpty() && this.state !== "ended") { this.#end(); return false; }

    if (this.state === "waiting") {
      this.world.damageEnabled = false; // peaceful lobby (movement + preview fire)
      this.#refillLobbyBots();
      this.#driveBots();
      this.world.step(dt);
      this.#broadcastState({ countdown: Math.max(0, this.countdown) });
      this.countdown -= dt;
      if (this.countdown <= 0) this.#startMatch();
      return true;
    }

    if (this.state === "playing") {
      this.world.damageEnabled = true;
      this.#driveBots();
      this.world.step(dt);
      this.#broadcastState();
      const alive = this.world.aliveCombatants();
      if (alive <= 1) {
        const w = this.world._list.find((e) => e.alive && (e.type === "player" || e.type === "bot"));
        if (w && w.type === "player") this.#awardMatchXp(w.id, true);
        if (w) this.#broadcast({ t: "winner", id: w.id, name: w.name, isBot: w.type === "bot" });
        console.log(`[iron-arena] ${this.id} winner: ${w ? w.id : "none"}`);
        this.state = "winner";
        this.winnerHold = this.cfg.WINNER_HOLD;
      }
      return true;
    }

    if (this.state === "winner") {
      // Keep broadcasting the final frame briefly so the winner/death screens settle,
      // then end + clean up (close remaining sockets → their clients are on an end
      // screen and return to the Main Menu).
      this.#broadcastState();
      this.winnerHold -= dt;
      if (this.winnerHold <= 0) { this.#end(); return false; }
      return true;
    }
    return false;
  }

  #end() {
    this.state = "ended";
    for (const ws of this.members.values()) { try { ws.match = null; ws.close(); } catch { /* ignore */ } }
    this.members.clear();
    console.log(`[iron-arena] ${this.id} ended`);
  }

  // --- kill attribution + authoritative match XP ---------------------------
  #onKill({ victim, killer }) {
    this.deadAt.set(victim, Date.now() / 1000);
    const k = killer ? this.world.get(killer) : null;
    const killerInfo = !k
      ? null
      : k.type === "guardian"
        ? { name: "a Guardian", isGuardian: true }
        : { name: k.name, color: k.color ?? 0, wrap: k.wrap ?? 0, weapon: k.weapon ?? 0, title: k.title ?? 0, killFx: k.killFx ?? 0, isBot: k.type === "bot" };
    if (k && k.type === "player") k._matchKills = (k._matchKills || 0) + 1;
    const ve = this.world.get(victim);
    if (ve && ve.type === "player") this.#awardMatchXp(victim, false);
    this.#broadcast({ t: "kill", victim, killer: killer ?? null, killerInfo });
  }

  #awardMatchXp(entityId, won) {
    const ws = this.members.get(entityId);
    const e = this.world.get(entityId);
    const acct = ws?.account;
    if (!acct || !e || e._matchAwarded) return;
    e._matchAwarded = true;
    const survival = e._matchStart ? (Date.now() - e._matchStart) / 1000 : 0;
    const kills = e._matchKills || 0;
    const xp = earnedXp({ kills, survival, won });
    const summary = this.accounts.awardXp(acct, xp);
    this.accounts.recordMatch(acct, { kills, survival, won });
    sendWs(ws, { t: "profile", profile: this.accounts.profile(acct), reward: { xp, ...summary, won } });
  }

  // --- broadcast -----------------------------------------------------------
  #broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.members.values()) { if (ws.readyState === ws.OPEN) { try { ws.send(s); } catch { /* ignore */ } } }
  }
  // State carries a per-recipient `ack` (their latest processed input seq), so each member gets
  // its own message — which also lets us trim what each recipient needs (bandwidth).
  #broadcastState(extra = {}) {
    const snap = this.world.snapshot();
    const now = Date.now();
    const lootSig = lootSignature(snap); // changes only when a pickup/crate appears, goes, or moves
    for (const [id, ws] of this.members) {
      if (ws.readyState !== ws.OPEN) continue;
      const e = this.world.get(id);
      const msg = { t: "state", now, lobby: this.id, ack: e?._ack ?? 0, ...extra, phase: snap.phase, alive: snap.alive, bullets: snap.bullets, players: this.#playersFor(ws, id, snap.players) };
      if (snap.fog) msg.fog = snap.fog;
      // Loot is mostly static: send it only when it changed (the client keeps the last list).
      if (ws._lootSig !== lootSig) { msg.crates = snap.crates; msg.pickups = snap.pickups; ws._lootSig = lootSig; }
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  // Bandwidth: identity/cosmetic fields (name, color, weapon, wrap, …) go out ONCE per recipient when a
  // participant first appears; afterwards only the moving state is sent. A participant's owned upgrades
  // (`up`) go only to that participant. The client merges these back into full records.
  #playersFor(ws, selfId, players) {
    const seen = (ws._seen ||= new Set());
    const out = new Array(players.length);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!seen.has(p.id)) { seen.add(p.id); out[i] = p.id === selfId ? p : withoutUp(p); continue; } // first sight: full record
      const c = { id: p.id, x: p.x, y: p.y, rot: p.rot, hp: p.hp, alive: p.alive };
      if (p.heat !== undefined) c.heat = p.heat;
      if (p.beam !== undefined) c.beam = p.beam;
      if (p.id === selfId && p.up !== undefined) c.up = p.up;
      out[i] = c;
    }
    if (seen.size > players.length * 2 + 16) { const live = new Set(players.map((q) => q.id)); for (const k of seen) if (!live.has(k)) seen.delete(k); }
    return out;
  }
}

// Drop the (owner-only) owned-upgrades field from a participant record sent to someone else.
function withoutUp(p) { const { up, ...rest } = p; return rest; }

// Cheap fingerprint of the loot lists (ids + positions) so unchanged loot isn't re-sent every tick.
function lootSignature(snap) {
  let h = 17;
  for (const c of snap.crates || []) h = (h * 31 + c.id * 7 + ((c.x * 10) | 0)) | 0;
  h = (h * 31 + 0x9e37) | 0;
  for (const p of snap.pickups || []) h = (h * 31 + p.id * 7 + ((p.x * 10) | 0) + ((p.y * 10) | 0)) | 0;
  return `${(snap.crates || []).length}:${(snap.pickups || []).length}:${h}`;
}
