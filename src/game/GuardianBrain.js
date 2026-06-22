// AI for an Arena Guardian: a heavy tank that holds the center. It aims at the
// nearest player/bot in range and otherwise idles; it drifts back toward the
// center if pushed out. Movement is minimal (guardians are slow anchors). Like
// BotBrain, it returns { move, aim } from think(dt, tank); firing is gated by the
// Tank's cooldown in Game (only when it has a target).

import { GAME } from "../config.js";

export class GuardianBrain {
  constructor(game) {
    this.game = game;
    this.idleAngle = Math.random() * Math.PI * 2;
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

    let aim;
    if (target) {
      aim = Math.atan2(target.y - tank.y, target.x - tank.x);
    } else {
      this.idleAngle += dt * 0.3; // slow sweep when nobody is near
      aim = this.idleAngle;
    }

    // Drift back toward the center if pushed beyond the home radius.
    let move = { x: 0, y: 0 };
    const distC = Math.hypot(tank.x, tank.y);
    if (distC > GAME.guardian.homeRadius) {
      const a = Math.atan2(-tank.y, -tank.x);
      move = { x: Math.cos(a), y: Math.sin(a) };
    }

    return { move, aim };
  }
}
