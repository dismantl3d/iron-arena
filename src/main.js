// Entry point. Creates the engine + input, then hands off to GameFlow, which
// owns the match-flow state machine (main menu → waiting room → match → death)
// and the Game itself. World scenery is built by the Game so it can swap between
// the calm waiting room and the full arena.

import "./ui/overlay.css";
import { Engine } from "./engine/Engine.js";
import { Input } from "./engine/Input.js";
import { GameFlow } from "./game/GameFlow.js";

async function start() {
  const engine = new Engine();
  await engine.init();

  const input = new Input();
  const flow = new GameFlow(engine, input);

  // Dev-only debug handle (stripped from production builds).
  if (import.meta.env.DEV) window.__game = { engine, input, flow, game: flow.game };
}

start();
