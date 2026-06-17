# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Iron Arena is a 2D top-down multiplayer tank IO game (Diep.io-inspired). Engine foundation is in place: rendering, camera-follow, and player input (WASD to move, mouse to aim).

## Commands

- `npm run dev` — Vite dev server (http://localhost:5173)
- `npm run build` — production build to `dist/`
- `npm run preview` — serve the production build

## Tech Stack

- **Rendering:** PixiJS v8 (async `Application.init()`, WebGL/WebGPU)
- **Build/dev:** Vite 6, ES modules
- **Server (future):** Node.js + WebSocket

## Code Structure

- `src/main.js` — entry point; wires the scene together (engine + grid + tank). Game-specific assembly lives here, not in the engine.
- `src/engine/` — gameplay-agnostic core. `Engine` owns the Pixi `Application`, the world `Container`, the camera, and the frame loop; it updates registered entities each tick. `Camera` pans/zooms by transforming the single world container so its `target` stays screen-centered, and exposes `screenToWorld()` for cursor-aim math. `Input` is a passive keyboard/mouse state holder (`isDown`, `moveAxis`, `mouse`) with no game logic — entities read it in their own `update()`.
- `src/entities/` — world objects (e.g. `Tank`). Each owns its world position/rotation and a Pixi view, and exposes `syncView()` (push transform to view) and optionally `update(dt)`.
- `src/render/` — pure rendering helpers: `shapes.js` (diep-style fill + auto-darkened bold outline), `Grid.js` (static world grid).
- `src/config.js` — all tunable visual/world constants. Add new colors and sizes here, not inline.

## Conventions

- All world-space objects are added to `engine.world` (via `addToWorld`/`addEntity`) so they pan and zoom with the camera. Screen-space UI would attach directly to `app.stage`.
- Outlines are never hand-picked: use the helpers in `shapes.js`, which derive a darker shade of the fill via `darken()`.
- The frame loop calls `entity.update(dt)` then `entity.syncView()`; entities mutate state in `update` and only touch their Pixi view in `syncView`.

## Visual Style

- Simple geometric shapes (circles, rectangles, polygons)
- Bold outlines: same color as fill but darker shade, thick stroke
- Heavy use of particles and effects

## Architecture Principles

- Keep rendering, input, and camera systems modular and decoupled
- Performance target: 30+ players and bots simultaneously
- No overengineering — build what's needed now
- Do NOT implement full gameplay systems until engine foundation is solid

## Development Phases

1. **Phase 1 (current):** Engine setup — PixiJS renderer, camera system, tank rendering
2. **Phase 2:** Input handling, basic movement
3. **Phase 3:** Server + WebSocket multiplayer
