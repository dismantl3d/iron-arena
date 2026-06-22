// A tank — used for BOTH the player and the AI bots, so they are literally the
// same "species": identical body, turret, outline, bullet style, HP, and health
// bar. What differs is the *controller*: the player reads `input` + `camera`;
// a bot has an `ai` brain. Set neither and the tank stands still.
//
// View structure (important): `view` is positioned at the tank's world spot but
// never rotated. The barrel/body live in a child `body` container that IS
// rotated, so the health bar (also a child of `view`) always stays upright.

import { Container } from "pixi.js";
import { COLORS, GAME } from "../config.js";
import { graphics, drawCircle, drawRect } from "../render/shapes.js";
import { HealthBar } from "../render/HealthBar.js";
import { approachAngle } from "../utils/angle.js";

const FLASH_DURATION = 0.12; // seconds of "hit punch" after taking damage

export class Tank {
  constructor({
    x = 0,
    y = 0,
    radius = 28,
    color = COLORS.tankBody,
    speed = GAME.player.speed, // world units per second
    turnRate = GAME.player.turnRate, // barrel aim responsiveness
    maxHp = GAME.player.maxHp,
    fireRate = GAME.player.fireRate, // seconds between shots
    input = null, // Input instance; null = not player-controlled
    camera = null, // needed to convert cursor screen pos -> world pos
    bounds = null, // arena bounds to stay inside
  } = {}) {
    this.x = x;
    this.y = y;
    this.radius = radius;
    this.color = color; // body fill (cosmetic); barrel/outline derive from it
    this.rotation = 0; // facing angle in radians

    this.speed = speed;
    this.turnRate = turnRate;
    this.maxHp = maxHp;
    this.hp = maxHp;
    this.fireRate = fireRate;
    this.input = input;
    this.camera = camera;
    this.bounds = bounds;

    // Optional bot controller (set by the Game). When present it drives movement
    // + aim instead of player input. Also used for future bot metadata.
    this.ai = null;
    this.team = "player"; // "player" | "bot" — used for bullet collisions
    this.level = 1; // structural only for bots (1–3); no gameplay effect yet

    this.armor = 0; // fraction of incoming damage blocked (0..1), set by upgrades
    this.barrelLength = radius * 2.2; // muzzle distance from center (for spawning bullets)
    this._fireTimer = 0; // counts down to next allowed shot
    this._flash = 0; // counts down the hit-punch animation
    this.dead = false;

    this.view = new Container();
    this.body = new Container(); // holds barrel + circle; this is what rotates
    this.healthBar = new HealthBar();
    this.#build(color);
    this.syncView();
  }

  // Per-frame movement + aim. The *source* of the move vector and desired aim
  // angle depends on the controller (AI brain or player input); the application
  // (translate, clamp to arena, smooth turret turn) is shared so the player and
  // bots move identically. Pure state update — view is refreshed in syncView().
  update(dt) {
    if (this._fireTimer > 0) this._fireTimer -= dt;
    if (this._flash > 0) this._flash -= dt;

    this.healthBar.set(this.hp / this.maxHp);
    this.healthBar.update(dt);

    let move = null; // {x, y} direction (need not be normalized; AI returns unit)
    let aim = null; // desired turret angle, or null to leave rotation as-is

    if (this.ai) {
      const cmd = this.ai.think(dt, this);
      move = cmd.move;
      aim = cmd.aim;
    } else if (this.input) {
      move = this.input.moveAxis();
      if (this.camera) {
        const m = this.camera.screenToWorld(this.input.mouse.x, this.input.mouse.y);
        aim = Math.atan2(m.y - this.y, m.x - this.x);
      }
    } else {
      return; // uncontrolled: nothing to move
    }

    this.x += move.x * this.speed * dt;
    this.y += move.y * this.speed * dt;

    // Keep the tank inside the arena.
    if (this.bounds) {
      this.x = Math.min(Math.max(this.x, this.bounds.minX + this.radius), this.bounds.maxX - this.radius);
      this.y = Math.min(Math.max(this.y, this.bounds.minY + this.radius), this.bounds.maxY - this.radius);
    }

    if (aim !== null) {
      this.rotation = approachAngle(this.rotation, aim, this.turnRate * dt);
    }
  }

  // Try to fire. Returns the spawn params for a bullet (muzzle position + angle)
  // if the cooldown has elapsed, otherwise null. The Game turns this into a Bullet.
  tryFire() {
    if (this._fireTimer > 0) return null;
    this._fireTimer = this.fireRate;
    return {
      x: this.x + Math.cos(this.rotation) * this.barrelLength,
      y: this.y + Math.sin(this.rotation) * this.barrelLength,
      angle: this.rotation,
    };
  }

  takeDamage(amount) {
    this.hp = Math.max(0, this.hp - amount * (1 - this.armor));
    this._flash = FLASH_DURATION;
  }

  // Builds the tank's geometry once. Barrel first so the body draws over its base.
  #build(color) {
    const barrelWidth = this.radius * 0.6;

    const barrel = graphics();
    // barrel points along +x (rotation 0 = facing right); base sits at origin
    drawRect(barrel, this.barrelLength / 2, 0, this.barrelLength, barrelWidth, COLORS.tankBarrel);

    this.circle = graphics();
    drawCircle(this.circle, 0, 0, this.radius, color);

    this.body.addChild(barrel, this.circle);
    this.healthBar.view.position.set(0, -(this.radius + 16));
    this.view.addChild(this.body, this.healthBar.view);
  }

  // Live-change the body color (used by the cosmetics picker in the waiting room).
  setColor(color) {
    this.color = color;
    this.circle.clear();
    drawCircle(this.circle, 0, 0, this.radius, color);
  }

  // Push the entity's state onto its view: position, barrel rotation, the brief
  // scale "punch" on hit, and the health bar fill.
  syncView() {
    this.view.position.set(this.x, this.y);
    this.body.rotation = this.rotation;
    const punch = this._flash > 0 ? 1 + 0.18 * (this._flash / FLASH_DURATION) : 1;
    this.body.scale.set(punch);
  }
}
