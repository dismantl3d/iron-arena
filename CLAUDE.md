# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Iron Arena is a 2D top-down **battle-royale** tank IO game (Diep.io-inspired). Flow: Main Menu → Waiting Room (30s countdown, customize) → Match → Death/Victory screen → (Play Again / Main Menu). A match has a **fixed roster** (player + bots up to `match.matchSize`, no respawns, deaths permanent, last tank alive wins). In-match upgrades are **collected as world pickups + loot crates** (rarity zones), shown in a bottom-right HUD — there is no buy-menu. A shrinking **toxic fog** squeezes everyone inward and **intensifies in the endgame** (faster shrink + loot lost outside it as the roster thins); **Arena Guardians** hold the high-loot center; procedural **walls** (impassable, block bullets) break up the map. A screen-space **minimap** shows players/bots/guardians/crates/walls + the fog edge. AI bots are the *same species* as the player (identical `Tank` driven by a `BotBrain`). **Iron Path** is the meta-progression: XP earned per match → level 1–60, unlocking a new weapon every 6 levels; the **Arsenal** equips unlocked weapons (each with a distinct turret). The **Cosmetics** locker (live showcase + sliding tabs) covers colors, body **wraps**, movement **trails**, **kill FX**, and **titles**. The world is a clean Diep-style **light** theme; tanks carry momentum (accel/glide) and the turret recoils on fire. UI is a flat style (no glow/blur/gradients) using Exo 2 (titles) + Ubuntu (body). Multiplayer networking is **not** built yet (bots are placeholders for other players).

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
- `src/game/Profile.js` — persisted player identity (username, weapon index, `ironPathXp`, and cosmetic indices: `cosmetic` color, `wrap`, `trail`, `killFx`, `title`) via `localStorage`. `displayName` falls back to "Unnamed Tank". `ironPathLevel` getter derives the level from XP; `addIronPathXp(n)` awards match XP and returns levels gained.
- `src/game/IronPath.js` — pure Iron Path progression helpers over `GAME.ironPath`: `levelForXp()`, `levelProgress()`, `unlockLevel(weaponIndex)`, `isWeaponUnlocked(level, i)`, `earnedXp({kills,survival,won})`. Single source of truth for the curve + weapon-unlock schedule.
- `src/engine/` — gameplay-agnostic core. `Engine` owns the Pixi `Application`, the world `Container`, the camera, and the frame loop. Each tick it (1) updates+syncs all entities, (2) runs registered **systems** (`addSystem`), (3) reaps entities flagged `dead` and destroys their views, (4) applies the camera. `Camera` smoothly lerps toward its `target` (`followSpeed`), clamps the view to `bounds`, supports `shake()`, and exposes `screenToWorld()` for cursor aim. `Input` is a passive keyboard/mouse state holder (`isDown`, `moveAxis`, `mouse`, `isFiring`); `wasPressed(code)` is an edge-trigger for toggles/menus (consumed once per press).
- `src/entities/` — world objects: `Tank` (used for player, bots, AND guardians — identical structure; player has `input`+`camera`, others have an `ai` brain; carries `team`, `level`, `armor`, `turret`, `wrap`; `setWeapon(w)` rebuilds the turret barrels, `setColor`/`setWrap` restyle the body; momentum via eased velocity + a turret `recoil` on fire), `Bullet` (straight-line, `team` so it only hits the other side), `UpgradePickup` (rarity-ringed circle / special hex, drawn with the shared upgrade icon), `Crate` (chunky brown reinforced loot container holding 3 upgrade `items`; opened by contact), `Wall` (static impassable rectangle; blocks movement + bullets), `Drone` (sentry/loot companion orbiting the player), `Particle` + `DamageNumber` (cosmetic). Each owns its world transform + a Pixi view and exposes `syncView()` and optionally `update(dt)`; self-flag `this.dead = true` to be removed.
- `src/game/Game.js` — the gameplay coordinator (NOT in the engine). Runs the **battle-royale** match: fixed roster at start (no respawns), team-based collisions (player/bot/guardian), world-pickup + loot-crate upgrades, specials, toxic fog, guardians, minimap, endgame, win/lose. **Phase lifecycle** (`menu`/`waiting`/`playing`/`dead`/`won`): `showMenuBackground()`, `enterWaiting(profile)`, `startMatch()` (swaps scenery, expands bounds, drops player into the outer ring, spawns roster + guardians + pickups + crates + fog). Two gates: `combatEnabled` (shooting — ON in the waiting room too, for loadout testing) and `damageEnabled` (hits/kills/upgrades/fog/XP — match only). Endgame: `#fogIntensity()` accelerates the fog as the roster thins (`GAME.endgame`), and `#consumeLootInFog()` removes loot left outside the safe zone. `#awardXp()` grants Iron Path XP on match end. `#applyStats()` merges base + weapon + collected-upgrade multipliers (`deriveUpgradeStats`). Plugs in via `engine.addSystem`.
- `src/game/upgrades.js` — pure data + helpers for the upgrade system: `RARITIES`/`RARITY_COLOR`/`RARITY_MUL`, `NORMAL_TYPES` (5 stat upgrades), `SPECIALS` (5 abilities), `ZONES` (concentric rarity bands + pickup/special counts), `pickRarity()`, `deriveUpgradeStats()`.
- `src/game/UpgradeState.js` — the player's collected upgrades for a match: `normals` (type→rarity, higher replaces lower, no stacking) + `specials` (max 2; a 3rd drops the oldest).
- `src/game/Fog.js` — toxic fog: shrinking safe radius, `isOutside(x,y)` for DoT, a glowing edge ring (world Graphics).
- `src/game/BotBrain.js` — bot AI (`think` → `{move, aim}`): eased wander, wall avoidance, separation. `src/game/GuardianBrain.js` — guardian AI: holds center, aims at the nearest player/bot in range (`hasTarget` gates firing).
- `src/utils/angle.js` — shared `approachAngle()` (shortest-path angular easing).
- `src/render/` — pure rendering helpers: `shapes.js` (diep-style fill + auto-darkened bold outline), `turret.js` (`turretBarrels(turret, R)` — shared barrel geometry per weapon, used by BOTH the in-world `Tank` and the SVG previews so they always match), `upgradeIcons.js` (`drawUpgradeIcon(g, key, color, s)` — flat bold glyph per upgrade, shared by the HUD slots AND the world pickups), `wraps.js` (`drawWrap()` — body wrap patterns, clipped to the tank circle), `Grid.js`, `Arena.js` (floor + border), `HealthBar.js` (eased fill, floats above an entity on its non-rotating view).
- `src/ui/` — two kinds of UI:
  - **In-world Pixi UI** on `app.stage`: `Hud.js` (score / "Alive" BR count / FPS + bottom HP bar; dark text for the light world), `UpgradeHud.js` (bottom-LEFT: 5 normal rarity-ringed circle+icon slots, 2 special hex slots, **custom animated hover tooltip**), and `Minimap.js` (top-right: flat high-contrast dots for player/bots/guardians/crates + wall rects + the fog-boundary ring; `update(state)` each playing frame). All `layout()` on resize.
  - **Screen-flow DOM overlays** over the canvas: `MainMenu.js`, `WaitingRoom.js` (countdown banner), `DeathScreen.js`, `WinnerScreen.js` (both show Iron Path XP earned), `CosmeticsPanel.js` (redesigned locker: live tank **showcase** above horizontally-**sliding tabs** — Colors / Wraps / Trails / Kill FX / Titles), `LockerPanels.js` (`ArsenalPanel` — 2-col scrollable weapon **card grid** with lock overlays, `IronPathPanel` — horizontal 1–60 progression track with weapon/cosmetic nodes + hover tooltips), `weaponPreview.js` (`weaponPreviewSvg()` flat tank+turret(+wrap) SVG for cards/track/showcase), `Tooltip.js` (shared flat animated tooltip — no browser title). Styled by `overlay.css` (flat style, Exo 2 + Ubuntu); built with `dom.js`. **Only one screen is active at a time** — opening a panel from the menu hides the menu (GameFlow `#openPanel`/`#backFromPanel`); panels render above everything (`.ia-scrim` z-index). Overlays are `pointer-events:none` except interactive bits, so keyboard movement still works underneath.
- `src/config.js` — all tunable constants (light-theme `COLORS` incl. `wall`/`crate`, `WORLD` incl. `arenaHalf`/`bounds`/`waitingBounds`, `GAME` incl. `player` (with `accel`/`recoil`), `bot`, `match` incl. `matchSize`, `guardian`, `fog`, `endgame`, `cosmetics`/`wraps`/`trails`/`killFx`/`titles`, `walls`, `weapons` (each with a `turret` layout + unlock order), `ironPath`, `crate`). Upgrade/rarity/zone data lives in `game/upgrades.js`. Add new values here, not inline.

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
8. **Phase 8 (done):** UI + progression + endgame — one-screen-at-a-time UI fix, flat style + Exo 2/Ubuntu fonts, Iron Path 1–60 (weapon every 6 levels) + per-match XP, Arsenal card system + visual turrets, loot crates, minimap, waiting-room shooting (no damage), endgame fog intensify/loot-thinning
9. **Phase 9 (done):** Cosmetics + presentation polish — redesigned Cosmetics locker (showcase + sliding tabs: colors/wraps/trails/kill FX/titles), shared flat upgrade icons (HUD bottom-left + world pickups), Iron Path tooltips, brown reinforced crates, procedural walls, light Diep-style world, movement momentum + turret recoil
10. **Phase 10:** Server + WebSocket multiplayer (bots are placeholders for real players)
