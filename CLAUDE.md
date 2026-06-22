# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Iron Arena is a 2D top-down **battle-royale** tank IO game (Diep.io-inspired). Flow: Main Menu → Waiting Room (30s countdown, customize) → Match → Death/Victory screen → (Play Again / Main Menu). A match has a **fixed roster** (player + bots up to `match.matchSize`, no respawns, deaths permanent, last tank alive wins). Upgrades are **collected as world pickups** (rarity zones), shown in a bottom-right HUD — there is no buy-menu and no level/XP progression. A shrinking **toxic fog** squeezes everyone inward; **Arena Guardians** hold the high-loot center. AI bots are the *same species* as the player (identical `Tank` driven by a `BotBrain`). Multiplayer networking is **not** built yet (bots are placeholders for other players); there is no meta progression / Iron Path XP logic yet.

Controls: WASD move · mouse aim · left-click shoot · Space dash (with Flash special) · F toggle FPS.

## Commands

- `npm run dev` — Vite dev server (http://localhost:5173)
- `npm run build` — production build to `dist/`
- `npm run preview` — serve the production build

## Tech Stack

- **Rendering:** PixiJS v8 (async `Application.init()`, WebGL/WebGPU)
- **Build/dev:** Vite 6, ES modules
- **Server (future):** Node.js + WebSocket

## Code Structure

- `src/main.js` — entry point; imports the overlay CSS, creates the `Engine` + `Input`, and hands off to `GameFlow`. No gameplay assembly here.
- `src/game/GameFlow.js` — the match-flow **state machine** (menu → waiting → playing → dead/won). Owns the `Profile`, the `Game`, and the DOM screen overlays (incl. `WinnerScreen`), and wires button clicks / countdown / death / victory to Game lifecycle calls. No networking.
- `src/game/Profile.js` — persisted player identity (username, cosmetic index, weapon index) via `localStorage`. `displayName` falls back to "Unnamed Tank". (`ironPathXp` field exists but is unused — no progression logic yet.)
- `src/engine/` — gameplay-agnostic core. `Engine` owns the Pixi `Application`, the world `Container`, the camera, and the frame loop. Each tick it (1) updates+syncs all entities, (2) runs registered **systems** (`addSystem`), (3) reaps entities flagged `dead` and destroys their views, (4) applies the camera. `Camera` smoothly lerps toward its `target` (`followSpeed`), clamps the view to `bounds`, supports `shake()`, and exposes `screenToWorld()` for cursor aim. `Input` is a passive keyboard/mouse state holder (`isDown`, `moveAxis`, `mouse`, `isFiring`); `wasPressed(code)` is an edge-trigger for toggles/menus (consumed once per press).
- `src/entities/` — world objects: `Tank` (used for player, bots, AND guardians — identical structure; player has `input`+`camera`, others have an `ai` brain; carries `team`, `level`, `armor`), `Bullet` (straight-line, `team` so it only hits the other side), `UpgradePickup` (rarity-colored square / special hex; sets `collected`), `Drone` (sentry/loot companion orbiting the player), `Particle` + `DamageNumber` (cosmetic). Each owns its world transform + a Pixi view and exposes `syncView()` and optionally `update(dt)`; self-flag `this.dead = true` to be removed.
- `src/game/Game.js` — the gameplay coordinator (NOT in the engine). Runs the **battle-royale** match: fixed roster at start (no respawns), team-based collisions (player/bot/guardian), world-pickup upgrades, specials, toxic fog, guardians, win/lose. **Phase lifecycle** (`menu`/`waiting`/`playing`/`dead`/`won`): `showMenuBackground()`, `enterWaiting(profile)`, `startMatch()` (swaps scenery, expands bounds, drops player into the outer ring, spawns roster + guardians + pickups + fog, enables combat). `combatEnabled` gates shooting/damage (waiting room = movement only). `#applyStats()` merges base + weapon + collected-upgrade multipliers (`deriveUpgradeStats`). Plugs in via `engine.addSystem`.
- `src/game/upgrades.js` — pure data + helpers for the upgrade system: `RARITIES`/`RARITY_COLOR`/`RARITY_MUL`, `NORMAL_TYPES` (5 stat upgrades), `SPECIALS` (5 abilities), `ZONES` (concentric rarity bands + pickup/special counts), `pickRarity()`, `deriveUpgradeStats()`.
- `src/game/UpgradeState.js` — the player's collected upgrades for a match: `normals` (type→rarity, higher replaces lower, no stacking) + `specials` (max 2; a 3rd drops the oldest).
- `src/game/Fog.js` — toxic fog: shrinking safe radius, `isOutside(x,y)` for DoT, a glowing edge ring (world Graphics).
- `src/game/BotBrain.js` — bot AI (`think` → `{move, aim}`): eased wander, wall avoidance, separation. `src/game/GuardianBrain.js` — guardian AI: holds center, aims at the nearest player/bot in range (`hasTarget` gates firing).
- `src/utils/angle.js` — shared `approachAngle()` (shortest-path angular easing).
- `src/render/` — pure rendering helpers: `shapes.js` (diep-style fill + auto-darkened bold outline), `Grid.js`, `Arena.js` (floor + border), `HealthBar.js` (eased fill, floats above an entity on its non-rotating view).
- `src/ui/` — two kinds of UI:
  - **In-world Pixi UI** on `app.stage`: `Hud.js` (score / "Alive" BR count / FPS + bottom HP bar) and `UpgradeHud.js` (bottom-right: 5 normal icon+rarity-bar slots, 2 special hex slots, **custom hover tooltip**). Both `layout()` on resize.
  - **Screen-flow DOM overlays** over the canvas: `MainMenu.js`, `WaitingRoom.js` (countdown banner), `DeathScreen.js`, `WinnerScreen.js`, `LockerPanels.js` (Cosmetics / Weapon / Iron Path). Styled by `overlay.css`; built with the `dom.js` helper. Overlays are `pointer-events:none` except interactive bits, so keyboard movement still works underneath.
- `src/config.js` — all tunable constants (`COLORS`, `WORLD` incl. `arenaHalf`/`bounds`/`waitingBounds`, `GAME` incl. `bot`, `match` incl. `matchSize`, `guardian`, `fog`, `cosmetics`, `weapons`). Upgrade/rarity/zone data lives in `game/upgrades.js`. Add new values here, not inline.

## Conventions

- All world-space objects are added to `engine.world` (via `addToWorld`/`addEntity`) so they pan and zoom with the camera. Screen-space UI (HUD) attaches directly to `app.stage`.
- Outlines are never hand-picked: use the helpers in `shapes.js`, which derive a darker shade of the fill via `darken()`.
- The frame loop calls `entity.update(dt)` then `entity.syncView()`; entities mutate state in `update` and only touch their Pixi view in `syncView`.
- An entity's `view` is positioned (not rotated) at its world spot; anything that rotates (e.g. a tank's barrel) goes in a child sub-container so upright children (health bars) aren't rotated.
- Removal is deferred: set `entity.dead = true` (or call `engine.removeEntity`); the Engine destroys the view during cleanup. Game-wide logic that spawns/removes entities belongs in a **system**, not an entity.

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

1. **Phase 1 (done):** Engine setup — PixiJS renderer, camera system, tank rendering
2. **Phase 2 (done):** Input handling, basic movement
3. **Phase 3 (done):** Single-player gameplay prototype — shooting, collisions, enemy bots, HP, arena, HUD
4. **Phase 4 (done):** Progression & polish — XP/levels/upgrades, combat feel (particles, shake, damage numbers), HUD polish
5. **Phase 5 (done):** Same-species bots (Tank + BotBrain), larger map
6. **Phase 6 (done):** Match flow — main menu, waiting room + countdown, match start/end, death screen, cosmetics/weapon/profile
7. **Phase 7 (done):** World + battle-royale — expanded map, world-pickup upgrades + rarity zones + upgrade HUD, special upgrades/drones, toxic fog, arena guardians, fixed-roster BR with permanent death + winner screen
8. **Phase 8:** Server + WebSocket multiplayer (bots are placeholders for real players)
