// AI for an Arena Guardian: a heavy tank that PATROLS the center. When no target
// is in range it slowly orbits the center at `patrolRadius` (holding its
// territory); when a player/bot comes within range it STOPS moving and aims at
// the nearest one (firing is gated by the Tank cooldown in Game). If shoved past
// `homeRadius` it steers straight back. It never chases across the map.
//
// Like BotBrain, think(dt, tank) returns { move, aim }.

import { GAME } from "../config.js";

export class GuardianBrain {
  constructor(game) {
    this.game = game;
    this.patrolAngle = Math.random() * Math.PI * 2; // position around the ring
    this.dir = Math.random() < 0.5 ? -1 : 1; // orbit direction
    this.idleAngle = Math.random() * Math.PI * 2; // turret sweep when idle
    this.hasTarget = false;
  }

  think(dt, tank) {
    const g = this.game;
    let target = null;
    let best = GAME.guardian.range;

    const consider = (t) => {
      if (!t || t.dead) return;
      const d = Math.hypot(t.x - tank.x, t.y - tank.y);
      if (d < best) {
        best = d;
        target = t;
      }
    };
    consider(g.player);
    for (const b of g.bots) consider(b);

    this.hasTarget = target !== null;

    let move = { x: 0, y: 0 };
    let aim;

    if (target) {
      // Engaged: stop and fire at the target (movement halts while shooting).
      aim = Math.atan2(target.y - tank.y, target.x - tank.x);
    } else {
      // Patrol: orbit the center along the patrol ring.
      this.patrolAngle += this.dir * GAME.guardian.patrolTurn * dt;
      const px = Math.cos(this.patrolAngle) * GAME.guardian.patrolRadius;
      const py = Math.sin(this.patrolAngle) * GAME.guardian.patrolRadius;
      const a = Math.atan2(py - tank.y, px - tank.x);
      move = { x: Math.cos(a), y: Math.sin(a) };
      this.idleAngle += dt * 0.3; // slow turret sweep
      aim = this.idleAngle;
    }

    // Hard territory bound: if pushed beyond home, steer straight back to center
    // (overrides patrol so guardians never wander off).
    if (Math.hypot(tank.x, tank.y) > GAME.guardian.homeRadius) {
      const a = Math.atan2(-tank.y, -tank.x);
      move = { x: Math.cos(a), y: Math.sin(a) };
    }

    return { move, aim };
  }
}
