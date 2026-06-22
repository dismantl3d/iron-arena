// Engine owns the PixiJS Application, the world container, the camera, and the
// frame loop. It is deliberately gameplay-agnostic: it renders a world and
// updates registered entities each tick. Game-specific wiring happens in main.js.

import { Application, Container } from "pixi.js";
import { COLORS } from "../config.js";
import { Camera } from "./Camera.js";

export class Engine {
  constructor() {
    this.app = new Application();
    this.world = new Container(); // all world-space objects live here
    this.camera = null;
    this.entities = []; // anything with an optional update(dt) + syncView()
    this.systems = []; // game-wide per-frame logic (collision, spawning, HUD)
  }

  // PixiJS v8 initializes asynchronously.
  async init() {
    await this.app.init({
      background: COLORS.background,
      resizeTo: window,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    document.body.appendChild(this.app.canvas);

    this.app.stage.addChild(this.world);
    this.camera = new Camera(this.world, this.app.screen);

    this.app.ticker.add((ticker) => this.#tick(ticker.deltaMS / 1000));
  }

  // Add a world-space object. Pass its view (Container/Graphics) to render it,
  // and optionally the entity itself if it needs per-frame updates.
  addToWorld(view) {
    this.world.addChild(view);
  }

  // Register an entity for per-frame updates. Entities may expose update(dt).
  addEntity(entity) {
    this.entities.push(entity);
    if (entity.view) this.addToWorld(entity.view);
    return entity;
  }

  // Flag an entity for removal; its view is destroyed during the next tick's
  // cleanup pass. Deferred so callers can remove safely mid-iteration.
  removeEntity(entity) {
    entity.dead = true;
  }

  // Immediately remove and destroy every entity (used when resetting between
  // matches). World scenery added via addToWorld is left untouched; registered
  // systems also remain.
  removeAllEntities() {
    for (const e of this.entities) {
      if (e.view) e.view.destroy({ children: true });
    }
    this.entities.length = 0;
  }

  // Register game-wide logic run once per frame, after all entities have
  // updated (so it sees fresh positions). Used for collision, spawning, HUD.
  addSystem(fn) {
    this.systems.push(fn);
  }

  #tick(dt) {
    // 1. advance every entity, then push its state to its view
    for (const e of this.entities) {
      if (typeof e.update === "function") e.update(dt);
      if (typeof e.syncView === "function") e.syncView();
    }
    // 2. run game systems (may flag entities dead or spawn new ones)
    for (const s of this.systems) s(dt);
    // 3. reap anything flagged dead this frame and free its GPU resources
    this.#removeDead();
    // 4. move the camera last so it tracks the final positions
    this.camera.apply(dt);
  }

  #removeDead() {
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      if (e.dead) {
        if (e.view) e.view.destroy({ children: true });
        this.entities.splice(i, 1);
      }
    }
  }
}
