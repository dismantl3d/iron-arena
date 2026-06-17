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
  }

  #tick(dt) {
    for (const e of this.entities) {
      if (typeof e.update === "function") e.update(dt);
      if (typeof e.syncView === "function") e.syncView();
    }
    this.camera.apply();
  }
}
