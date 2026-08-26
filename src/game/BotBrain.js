// BotBrain — the ORCHESTRATOR of a bot's modular AI. It owns the bot's profile
// (skill + personality + evolvable params) and, on a throttled plan tick, wires
// together the separate decision systems:
//
//   context.perceive()      -> what the bot currently senses (cached)
//   targeting.chooseTarget() -> which enemy to focus
//   objectives.chooseObjective() -> the single active goal
//
// then EXECUTES that goal every frame into { move, aim } and a `wantsFire` flag
// (the Game only shoots when it's true). Skill shapes execution (aim error,
// reaction lag, prediction) — never raw stats. Human imperfections are sprinkled
// in. Keeping perception/targeting/objectives in their own modules leaves room
// for the later evolutionary trainer to tune parameters without a rewrite.

import { approachAngle } from "../utils/angle.js";
import { GAME } from "../config.js";
import { makeProfile } from "./ai/BotProfile.js";
import { perceive, detectIncoming } from "./ai/context.js";
import { chooseTarget } from "./ai/targeting.js";
import { chooseObjective, OBJ } from "./ai/objectives.js";

// Objectives that involve combat / active threat (drive per-frame dodging, tight
// separation, etc.).
const COMBAT_OBJ = new Set([OBJ.ATTACK_ENEMY, OBJ.CHASE_ENEMY, OBJ.FIGHT_GUARDIAN, OBJ.RETREAT, OBJ.ESCAPE_DANGER, OBJ.WAIT]);

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

// A point-blank enemy is an immediate threat that forces a fresh decision.
const POINT_BLANK = 360;
// Arena Guardians are major environmental hazards: bots steer away from a live one
// within this range (unless deliberately fighting it), arcing around its fire.
const GUARD_AVOID = 380;

// A tank's ACTUAL projectile reach (speed × life) — bots fire within this, and it
// scales with the tank's bullet-speed/range upgrades. Falls back to the Standard
// baseline if a tank hasn't had its stats resolved yet.
function bulletReach(tank) {
  const sp = tank._bulletSpeed || GAME.weapons[0].bulletSpeed;
  const lf = tank._bulletLife || GAME.weapons[0].bulletLife;
  return sp * lf;
}

// Signed shortest angular difference b - a in (-PI, PI].
function angDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

export class BotBrain {
  constructor(game, genome = null) {
    this.game = game;
    this.profile = makeProfile(genome); // genome = an evolved policy, or null for random
    // Convenience mirrors (read by the Game/UI + tests).
    this.skill = this.profile.skill;
    this.personality = this.profile.personality;

    this.ctx = null;
    this.target = null;
    this.objective = OBJ.EXPLORE;
    this.wantsFire = false;

    // Timers + execution state.
    this._plan = Math.random() * 0.3;
    this._react = 0; // reaction lag before acting on a fresh target
    this._pause = 0; // brief hesitation
    this._aimOff = 0; // smoothed aim error
    this._miss = 0; // transient big aim slip
    this._missT = 0;
    this._strafe = Math.random() < 0.5 ? -1 : 1;

    // Dodging imperfection state: a reaction delay before reacting to a fresh
    // threat + a smoothed direction error, so bots aren't mathematically perfect.
    this._dodgeReact = 0;
    this._dodgeErrOff = 0;
    this._prevThreatTime = Infinity;

    // Wander.
    this.heading = Math.random() * TAU;
    this.targetHeading = this.heading;
    this._wander = 0;

    // Separation steering, written by Game.#separateBots() each frame.
    this.avoidX = 0;
    this.avoidY = 0;
  }

  think(dt, tank) {
    // Calm scenes (menu / waiting room): just amble around, never target/fire.
    if (this.game.phase !== "playing") {
      this.wantsFire = false;
      return this.#wanderCmd(dt, tank);
    }

    // React immediately to being attacked: force a re-decision this frame instead
    // of blindly continuing toward loot/exploration.
    if (this._lastHp !== undefined && tank.hp < this._lastHp - 0.01) this._plan = 0;
    this._lastHp = tank.hp;

    // Snap-react to an enemy entering point-blank range: don't wait up to a full
    // plan interval to notice someone in our face. Cheap — only the human + the
    // cached perceived enemies (≤5) are checked, and only when not already fighting.
    if (this.ctx && this._plan > 0 && !COMBAT_OBJ.has(this.objective) && this.#threatClose(tank)) {
      this._plan = 0;
    }

    // Throttled: perception + target + objective a few times a second. Always
    // (re)plan on the first playing frame so `ctx` exists before execution.
    this._plan -= dt;
    if (this._plan <= 0 || !this.ctx) {
      const [a, b] = GAME.ai.planInterval;
      this._plan = rand(a, b);
      this.ctx = perceive(this.game, tank, this.profile);
      const prevTarget = this.target;
      this.target = chooseTarget(this.ctx, tank, this.profile);
      this.objective = chooseObjective(this.ctx, this.target, this.profile);
      if (this.target && this.target !== prevTarget) this._react = rand(0.1, this.profile.params.reactionTime + 0.1);
      this.#maybeImperfection();
    }

    // Dodging needs faster reaction than the plan tick: refresh perceived
    // incoming fire every frame while in combat (cheap — only fighting bots).
    if (this.ctx && COMBAT_OBJ.has(this.objective)) this.ctx.incoming = detectIncoming(this.game, tank);

    // Brief human hesitation: hold position + fire.
    if (this._pause > 0) {
      this._pause -= dt;
      this.wantsFire = false;
      return { move: { x: 0, y: 0 }, aim: tank.rotation };
    }

    return this.#execute(dt, tank);
  }

  #maybeImperfection() {
    const s = this.profile.skill;
    if (Math.random() < 0.05 * (1 - s)) this._pause = rand(0.15, 0.5); // hesitate
    if (Math.random() < 0.2 * (1 - s)) {
      this._miss = rand(-0.35, 0.35); // an off burst
      this._missT = rand(0.25, 0.55);
    }
    if (Math.random() < 0.3) this._strafe = Math.random() < 0.5 ? -1 : 1;
  }

  // --- execution (every frame, cheap) --------------------------------------

  #execute(dt, tank) {
    if (this._react > 0) this._react -= dt;
    if (this._missT > 0) {
      this._missT -= dt;
      if (this._missT <= 0) this._miss = 0;
    }
    // Drift a small, smoothed aim error (steadier for higher aim accuracy). A tiny
    // floor keeps even elite aim from being mechanically perfect — they still very
    // occasionally misjudge a shot like a skilled human.
    const acc = this.profile.params.aimAccuracy;
    const targetErr = rand(-1, 1) * (0.03 + (1 - acc) * 0.13);
    this._aimOff += (targetErr - this._aimOff) * Math.min(1, dt * 3);

    const ctx = this.ctx;
    let move = { x: 0, y: 0 };
    let aim = tank.rotation;
    this.wantsFire = false;

    const toward = (x, y) => {
      const a = Math.atan2(y - tank.y, x - tank.x);
      return { x: Math.cos(a), y: Math.sin(a) };
    };
    const awayFrom = (x, y) => {
      const a = Math.atan2(tank.y - y, tank.x - x);
      return { x: Math.cos(a), y: Math.sin(a) };
    };

    switch (this.objective) {
      case OBJ.ATTACK_ENEMY:
      case OBJ.CHASE_ENEMY:
      case OBJ.FIGHT_GUARDIAN: {
        const t = this.objective === OBJ.FIGHT_GUARDIAN ? ctx.guardian : this.target;
        if (!t || t.dead) {
          move = this.#wanderVec(dt, tank);
          break;
        }
        const dx = t.x - tank.x;
        const dy = t.y - tank.y;
        const d = Math.hypot(dx, dy) || 1;
        const pr = this.profile.params.preferredRange;
        // Position according to the bot's weapon style (kite / push / circle / poke).
        move = this.#positionForCombat(tank, t, dx, dy, d, pr);

        // Lead-predict the target (better prediction with higher skill), + error.
        // Uses the tank's ACTUAL bullet speed (upgrades make leading tighter). The
        // lead is slightly UNDER-estimated (× 0.9) and jittered by skill so bots
        // don't lead a moving target with machine precision — they misjudge a little.
        const bulletSpeed = tank._bulletSpeed || GAME.weapons[0].bulletSpeed;
        const leadErr = 1 - (1 - this.profile.skill) * rand(0, 0.35);
        const lead = Math.min(0.5, d / bulletSpeed) * this.profile.skill * 0.9 * leadErr;
        const px = t.x + (t.vx || 0) * lead;
        const py = t.y + (t.vy || 0) * lead;
        aim = Math.atan2(py - tank.y, px - tank.x) + this._aimOff + this._miss;

        const aligned = Math.abs(angDiff(tank.rotation, aim)) < 0.16 + (1 - this.profile.params.aimAccuracy) * 0.25;
        // Fire within the bullet's ACTUAL effective reach (scales with this bot's
        // bullet-speed/range upgrades) whenever roughly on target. No HP gate —
        // deciding to fight is the objective's job; a low-HP bot still shoots to
        // finish a kill.
        this.wantsFire = this._react <= 0 && d < bulletReach(tank) * 0.9 && aligned;
        break;
      }

      case OBJ.WAIT: {
        // Third-party: hold near preferred range, watch the target, don't commit
        // yet. A re-plan flips to ATTACK the moment the target is worth diving.
        const t = this.target;
        if (!t || t.dead) {
          move = this.#wanderVec(dt, tank);
          break;
        }
        const dx = t.x - tank.x;
        const dy = t.y - tank.y;
        const d = Math.hypot(dx, dy) || 1;
        const pr = this.profile.params.preferredRange * 1.25; // hang back a bit
        if (d < pr * 0.9) move = awayFrom(t.x, t.y);
        else if (d > pr * 1.2) move = toward(t.x, t.y);
        else move = { x: (-dy / d) * this._strafe, y: (dx / d) * this._strafe };
        aim = Math.atan2(dy, dx); // keep it in the sights
        break;
      }

      case OBJ.RETREAT:
      case OBJ.ESCAPE_DANGER: {
        // Smart retreat: flee toward safety but DIAGONALLY (not a straight line an
        // enemy can track), avoid running into the threat, and fire back if capable.
        let v = toward(0, 0);
        if (ctx.enemy && ctx.enemyDist < 520) {
          const a = awayFrom(ctx.enemy.x, ctx.enemy.y);
          v = { x: v.x + a.x * 1.2, y: v.y + a.y * 1.2 };
          // add a perpendicular juke so the path isn't predictable
          v = { x: v.x - a.y * 0.5 * this._strafe, y: v.y + a.x * 0.5 * this._strafe };
        }
        move = v;
        // Skilled/aggressive bots fire back while retreating (fighting withdrawal).
        if (ctx.enemy && ctx.enemyDist < 520 && this.profile.skill > 0.55 && this.profile.params.aggression > 0.5) {
          aim = Math.atan2(ctx.enemy.y - tank.y, ctx.enemy.x - tank.x) + this._aimOff;
          this.wantsFire = this._react <= 0 && Math.abs(angDiff(tank.rotation, aim)) < 0.3;
        } else {
          aim = Math.atan2(move.y, move.x);
        }
        break;
      }

      case OBJ.ROTATE_TO_SAFE_ZONE:
        move = toward(0, 0);
        aim = Math.atan2(move.y, move.x);
        break;

      case OBJ.FIND_CRATE:
      case OBJ.COLLECT_UPGRADE: {
        const l = ctx.loot;
        if (!l || l.dead) {
          move = this.#wanderVec(dt, tank);
          aim = Math.atan2(move.y, move.x);
          break;
        }
        const ld = Math.hypot(l.x - tank.x, l.y - tank.y); // live distance
        if (this.objective === OBJ.FIND_CRATE) {
          // Hold at a firing distance and shoot the crate open (driving onto it
          // would make the muzzle overshoot). Bot bullets break crates.
          move = ld > 130 ? toward(l.x, l.y) : { x: 0, y: 0 };
          aim = Math.atan2(l.y - tank.y, l.x - tank.x);
          this.wantsFire = ld < 240 && Math.abs(angDiff(tank.rotation, aim)) < 0.22;
        } else {
          // Upgrades are picked up by proximity — just drive onto them.
          move = toward(l.x, l.y);
          aim = Math.atan2(move.y || 1e-4, move.x || 1e-4);
        }
        // Self-defence if an enemy is right on top of us.
        if (ctx.enemy && ctx.enemyDist < 220) {
          aim = Math.atan2(ctx.enemy.y - tank.y, ctx.enemy.x - tank.x) + this._aimOff;
          this.wantsFire = this._react <= 0 && Math.abs(angDiff(tank.rotation, aim)) < 0.3;
        }
        break;
      }

      case OBJ.EXPLORE:
      default:
        move = this.#wanderVec(dt, tank);
        aim = Math.atan2(move.y, move.x);
        // Rare human-like "bored" shot into open space while wandering — a single
        // infrequent pop, never during meaningful action (only pure exploration
        // with no target to shoot). Keeps idle bots from being eerily silent.
        if (this._react <= 0 && Math.random() < 0.0008) this.wantsFire = true;
        break;
    }

    // Arena Guardian avoidance: a nearby LIVE guardian is a major hazard. Unless
    // we're deliberately fighting it (or it's nearly dead and finishable), add an
    // away-from-guardian push that grows as it gets closer — so bots arc around
    // guardian fire while looting / travelling / chasing / even fighting the player
    // near one, instead of walking into it. Perception-limited (ctx.guardian only
    // exists within awareness).
    if (ctx.guardian && this.objective !== OBJ.FIGHT_GUARDIAN && (ctx.guardianHpFrac ?? 1) >= 0.3 && ctx.guardianDist < GUARD_AVOID) {
      const gax = Math.atan2(tank.y - ctx.guardian.y, tank.x - ctx.guardian.x);
      const w = (1 - ctx.guardianDist / GUARD_AVOID) * 1.7; // stronger the closer it is
      move = { x: move.x + Math.cos(gax) * w, y: move.y + Math.sin(gax) * w };
    }

    // Projectile dodging: overlay a juke when a perceived incoming shot reads as
    // dangerous. Deliberately imperfect — a skill-scaled reaction delay, a chance
    // to misjudge, direction error, and reduced success against overlapping shots —
    // so bots dodge like very good humans, not like flawless robots.
    if (ctx.incoming) {
      const dodge = this.#dodgeVector(ctx.incoming, dt);
      if (dodge) move = { x: move.x * 0.35 + dodge.x * 1.1, y: move.y * 0.35 + dodge.y * 1.1 };
    } else {
      this._prevThreatTime = Infinity; // no threat -> next one is "fresh" (reaction delay applies)
    }

    // Damp the anti-clump separation for objectives that need to reach an exact
    // spot: full fights (close to lethal range) and looting (drive fully onto the
    // pickup instead of orbiting it at separation distance).
    const inCombat = COMBAT_OBJ.has(this.objective);
    const looting = this.objective === OBJ.FIND_CRATE || this.objective === OBJ.COLLECT_UPGRADE;
    move = this.#steer(move, tank, inCombat ? 0.12 : looting ? 0.22 : 0.5);
    const ml = Math.hypot(move.x, move.y);
    if (ml > 1e-3) {
      move.x /= ml;
      move.y /= ml;
    }
    return { move, aim };
  }

  // --- helpers --------------------------------------------------------------

  // Movement while fighting, shaped by the bot's weapon STYLE. Returns a (raw)
  // direction vector; normalisation happens in the caller.
  #positionForCombat(tank, t, dx, dy, d, pr) {
    const inx = dx / d;
    const iny = dy / d; // toward target
    const px = (-dy / d) * this._strafe;
    const py = (dx / d) * this._strafe; // strafe
    if (this.objective === OBJ.CHASE_ENEMY || d > pr * 1.2) return { x: inx, y: iny };
    switch (this.profile.style.kind) {
      case "kite": // Sniper/Cannon/Rocketeer: keep distance, strafe, back off if crowded
        if (d < pr * 0.85) return { x: -inx * 0.8 + px * 0.5, y: -iny * 0.8 + py * 0.5 };
        return { x: px * 0.9 - inx * 0.15, y: py * 0.9 - iny * 0.15 };
      case "circle": // Flank: orbit the target
        if (d < pr * 0.7) return { x: -inx, y: -iny };
        return { x: px, y: py };
      case "push": // Machine Gun/Laser: pressure, strafe while creeping in
        if (d > pr) return { x: inx * 0.5 + px * 0.8, y: iny * 0.5 + py * 0.8 };
        return { x: px * 0.85 + inx * 0.15, y: py * 0.85 + iny * 0.15 };
      case "poke":
      default: // Standard/Burst: close in + strafe, disengage only when very close
        if (d < pr * 0.55) return { x: -inx, y: -iny };
        return { x: px * 0.85 + inx * 0.3, y: py * 0.85 + iny * 0.3 };
    }
  }

  // Decide whether and HOW to dodge a perceived incoming shot, imperfectly. Returns
  // a (unit-ish) dodge direction or null. Sources of imperfection, all skill-scaled:
  //   • reaction delay before reacting to a freshly-seen threat (nobody is instant),
  //   • a "don't dodge everything" window + a chance to misjudge and not commit,
  //   • an angular error on the escape direction,
  //   • reduced success when multiple bullets threaten at once (overlapping shots).
  #dodgeVector(inc, dt) {
    const s = this.profile.skill;
    const p = this.profile.params;

    // Reaction delay: restart a short timer whenever a NOTABLY sooner threat appears
    // (a fresh danger). Elites react fast, beginners slower; never instant.
    if (inc.time < this._prevThreatTime - 0.05) {
      this._dodgeReact = 0.06 + (1 - s) * 0.2 + Math.random() * 0.04;
    }
    this._prevThreatTime = inc.time;
    if (this._dodgeReact > 0) {
      this._dodgeReact -= dt;
      return null; // still reacting — hasn't started dodging yet
    }

    // Danger window: don't bother with shots that are still far off in time.
    const window = 0.16 + p.dodgeTendency * 0.35 + s * 0.12;
    if (inc.time > window) return null;

    // Chance to actually commit this frame — imperfect judgment. Overlapping shots
    // (count > 1) are markedly harder, so the bot often mishandles them.
    const multi = (inc.count || 1) > 1 ? 0.6 : 1;
    const commit = (0.45 + p.dodgeTendency * 0.4 + s * 0.15) * multi;
    if (Math.random() > commit) return null; // misjudged / didn't react this frame

    // Imperfect escape direction: skilled bots juke cleanly, others err in the
    // angle (and more so under multiple threats).
    const errAmt = (0.1 + (1 - s) * 0.5) * ((inc.count || 1) > 1 ? 1.5 : 1);
    const targetErr = rand(-1, 1) * errAmt;
    this._dodgeErrOff += (targetErr - this._dodgeErrOff) * Math.min(1, dt * 6);
    const a = Math.atan2(inc.dodgeY, inc.dodgeX) + this._dodgeErrOff;
    return { x: Math.cos(a), y: Math.sin(a) };
  }

  // Is a live enemy at point-blank right now? Checks the human player + the cached
  // perceived enemies (≤5) — a few distance checks, not a global scan. Used to
  // force an immediate re-plan so nobody gets ignored in our face.
  #threatClose(tank) {
    const R2 = POINT_BLANK * POINT_BLANK;
    const near = (t) => {
      if (!t || t.dead || t === tank || t.team === tank.team) return false;
      const dx = t.x - tank.x;
      const dy = t.y - tank.y;
      return dx * dx + dy * dy < R2;
    };
    if (near(this.game.player)) return true;
    const es = this.ctx?.enemies;
    if (es) for (const e of es) if (near(e.tank)) return true;
    return false;
  }

  #wanderVec(dt, tank) {
    this._wander -= dt;
    if (this._wander <= 0) {
      this.targetHeading = Math.random() * TAU;
      this._wander = rand(1.5, 4);
    }
    this.heading = approachAngle(this.heading, this.targetHeading, 2 * dt);
    return { x: Math.cos(this.heading), y: Math.sin(this.heading) };
  }

  #wanderCmd(dt, tank) {
    const move = this.#steer(this.#wanderVec(dt, tank), tank, 0.5);
    return { move, aim: Math.atan2(move.y, move.x) };
  }

  // Arena-edge avoidance + anti-clump separation (sepScale damps separation while
  // fighting so bots can close in).
  #steer(move, tank, sepScale) {
    const b = tank.bounds;
    const margin = 320;
    let wx = 0;
    let wy = 0;
    if (tank.x < b.minX + margin) wx += 1;
    if (tank.x > b.maxX - margin) wx -= 1;
    if (tank.y < b.minY + margin) wy += 1;
    if (tank.y > b.maxY - margin) wy -= 1;
    return {
      x: move.x + wx * 1.2 + (this.avoidX || 0) * sepScale,
      y: move.y + wy * 1.2 + (this.avoidY || 0) * sepScale,
    };
  }
}
