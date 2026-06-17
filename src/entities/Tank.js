// A Tank is a self-contained visual entity. Phase 1: rendering only — it owns
// its world position and a PixiJS Container holding its body + barrel.
// No movement, input, or combat logic lives here yet.

import { Container } from "pixi.js";
import { COLORS } from "../config.js";
import { graphics, drawCircle, drawRect } from "../render/shapes.js";

// Step `current` toward `target` (radians) by fraction `t`, taking the shortest
// way around the circle. t is clamped to 1, giving smooth exponential-style turning.
function approachAngle(current, target, t) {
  let diff = target - current;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // wrap to [-PI, PI]
  return current + diff * Math.min(t, 1);
}

export class Tank {
  constructor({
    x = 0,
    y = 0,
    radius = 28,
    color = COLORS.tankBody,
    speed = 260, // world units per second
    input = null, // Input instance; null = not player-controlled
    camera = null, // needed to convert cursor screen pos -> world pos
  } = {}) {
    this.x = x;
    this.y = y;
    this.radius = radius;
    this.rotation = 0; // facing angle in radians

    this.speed = speed;
    this.turnRate = 12; // higher = snappier aim
    this.input = input;
    this.camera = camera;

    this.view = new Container();
    this.#build(color);
    this.syncView();
  }

  // Per-frame: WASD translates in world space; the barrel eases toward the cursor.
  // Pure state update — the view is refreshed separately in syncView().
  update(dt) {
    if (!this.input) return;

    const move = this.input.moveAxis();
    this.x += move.x * this.speed * dt;
    this.y += move.y * this.speed * dt;

    if (this.camera) {
      const m = this.camera.screenToWorld(this.input.mouse.x, this.input.mouse.y);
      const aim = Math.atan2(m.y - this.y, m.x - this.x);
      this.rotation = approachAngle(this.rotation, aim, this.turnRate * dt);
    }
  }

  // Builds the tank's geometry once. Barrel first so the body draws over its base.
  #build(color) {
    const barrelLength = this.radius * 2.2;
    const barrelWidth = this.radius * 0.6;

    const barrel = graphics();
    // barrel points along +x (rotation 0 = facing right); base sits at origin
    drawRect(barrel, barrelLength / 2, 0, barrelLength, barrelWidth, COLORS.tankBarrel);

    const body = graphics();
    drawCircle(body, 0, 0, this.radius, color);

    this.view.addChild(barrel, body);
  }

  // Push the entity's world transform onto its view. Called when x/y/rotation change.
  syncView() {
    this.view.position.set(this.x, this.y);
    this.view.rotation = this.rotation;
  }
}
