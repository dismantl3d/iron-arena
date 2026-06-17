// Entry point. Wires the Phase 1 scene together: engine, background grid, and a
// single tank centered in the world. No input or gameplay yet.

import { Engine } from "./engine/Engine.js";
import { Input } from "./engine/Input.js";
import { createGrid } from "./render/Grid.js";
import { Tank } from "./entities/Tank.js";

async function start() {
  const engine = new Engine();
  await engine.init();

  const input = new Input();

  // Background grid sits behind everything in world space.
  engine.addToWorld(createGrid());

  // Player tank at world origin: WASD to move, barrel aims at the cursor.
  // The camera follows it, so it stays centered while the world scrolls.
  const tank = new Tank({ x: 0, y: 0, input, camera: engine.camera });
  engine.addEntity(tank);
  engine.camera.follow(tank);

  // Dev-only debug handle (stripped from production builds).
  if (import.meta.env.DEV) window.__game = { engine, tank, input };
}

start();
