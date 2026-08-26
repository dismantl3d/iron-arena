// Global engine + visual + gameplay constants. Keep tunable values here, not
// scattered in code, so balance/feel can be adjusted in one place.

// Diep.io-inspired LIGHT world: a clean light-gray floor, soft gray grid, and a
// slightly darker border. Colored tanks/bullets pop against it. (Screen-space UI
// — HUD/minimap/tooltips — keeps its own dark cards for contrast.)
export const COLORS = {
  background: 0xb9bec8, // outside the arena (light void)
  arenaFloor: 0xcdd2db, // the playable area
  grid: 0xc1c6d0, // soft gray grid lines
  arenaBorder: 0x9097a3, // slightly darker border

  tankBody: 0x00b0e9, // player blue
  // Barrels are two-tone (per the weapon PDF): a dark charcoal outer shell with a
  // lighter-gray inset core.
  tankBarrel: 0x9aa0aa, // light inner core
  tankBarrelDark: 0x565a63, // dark outer shell

  wall: 0xa9aeb9, // procedural walls (world-toned), darker outline derived
  crate: 0x9c6b3f, // loot crate brown
  crateEdge: 0x5e3f24, // crate reinforced corners / outline

  hpBg: 0x2a2a2a,
  hpFill: 0x76d672, // health-bar green

  xpFill: 0xffd24a, // XP bar / orbs gold
  xpOrb: 0x8be0ff,
  xpBg: 0x2a2a2a,

  hitSpark: 0xffd24a, // bullet-impact particles
  hudText: 0x20242c, // dark text (readable on the light world)
  hudDim: 0x5b616e, // secondary HUD text

  damageText: 0x9a4b00,
  menuPanel: 0x191920,
  menuBorder: 0x3a3a48,
  pipOn: 0x76d672,
  pipOff: 0x33333d,
};

// Bold outlines: same hue as the fill but darker, drawn thick.
export const OUTLINE = {
  darken: 0.75, // multiply a fill color by this to get its outline color
  width: 4,
};

const arenaHalf = 6000; // half-extent of the square arena, in world units (much larger than the view)
const waitingHalf = 1000; // small calm area used by the waiting room
export const WORLD = {
  gridSize: 64, // px between grid lines
  arenaHalf,
  bounds: {
    minX: -arenaHalf,
    minY: -arenaHalf,
    maxX: arenaHalf,
    maxY: arenaHalf,
  },
  // The waiting room is a smaller, calmer space; entities teleport into the
  // full `bounds` when the match starts.
  waitingBounds: {
    minX: -waitingHalf,
    minY: -waitingHalf,
    maxX: waitingHalf,
    maxY: waitingHalf,
  },
};

// Gameplay tuning. Times are in seconds, speeds in world units / second.
export const GAME = {
  camera: {
    followSpeed: 6, // higher = camera catches up faster
    shakeDecay: 30, // how fast a shake settles (units/sec)
    shakeMax: 24, // cap so big bursts don't nauseate
    // World events (bot deaths, crate breaks) shake THIS player's camera only by
    // distance: full within `shakeNear`, linear falloff to zero at `shakeFar`.
    shakeNear: 700, // full-strength shake within this world distance of the player
    shakeFar: 2200, // no shake at/beyond this distance (across-map events are silent)
  },

  // Base player stats. Upgrades are applied on top of these (see `upgrades`).
  player: {
    maxHp: 100,
    speed: 280,
    turnRate: 16, // barrel aim responsiveness
    fireRate: 0.16, // seconds between shots
    contactInvuln: 0.7, // i-frames after taking contact damage
    accel: 11, // velocity easing rate — higher = snappier, lower = more glide
    recoil: 6, // turret kick-back distance on fire (visual only)
    recoilRecover: 14, // how fast the barrel slides back out
  },

  // Base bullet stats (damage/speed are raised by upgrades).
  bullet: { speed: 780, radius: 7, life: 1.2, damage: 25 },

  // Bots: AI tanks identical to the player (same size/look/bullets). In the
  // battle-royale loop the population is FIXED at match start (no respawns).
  // NOTE: bots now use the PLAYER's Standard weapon + base stats (resolved in
  // Game#applyBotStats from GAME.weapons[0] + GAME.player + upgrades) — there is no
  // separate bot combat stat set. The hp/speed/turnRate/fireRate/bullet* fields
  // below are LEGACY/unused for live combat; only score/contactDamage/separation/
  // directionInterval/level* still drive gameplay.
  bot: {
    hp: 100, // (legacy) bots inherit GAME.player.maxHp
    speed: 150, // (legacy) bots inherit GAME.player.speed
    turnRate: 9, // (legacy) bots inherit GAME.player.turnRate
    contactDamage: 12,
    score: 100, // awarded per bot killed
    fireRate: 1.3, // (legacy) bots inherit the Standard weapon cooldown
    bulletDamage: 10, // (legacy) bots inherit the Standard shot damage
    bulletSpeed: 640, // (legacy) bots inherit the Standard bulletSpeed
    bulletLife: 1.2, // (legacy) bots inherit the Standard bulletLife
    separation: 90, // anti-clump spacing in world units
    directionInterval: [2, 4.5], // seconds between wander heading changes
    levelMin: 1,
    levelMax: 3, // bot.level is set in this range, no effect yet
    label: "BOT", // username placeholder shown above each bot
  },

  // Battle royale loop: population is fixed at match start (1 player + bots up
  // to matchSize), no new spawns after, deaths permanent, last tank standing wins.
  match: {
    countdown: 15, // seconds in the waiting room before the match starts
    waitingBots: 6, // bots shown idling in the waiting room
    matchSize: 30, // total roster (player + bots) — configurable; scales toward 100 later
  },

  // Bot AI (Phase 1): a modular decision system. `skillTiers` labels the
  // continuous 0..1 skill score; `skillDistribution` is the target population mix
  // (both configurable — an evolutionary trainer will replace the sampler later).
  // `personalities` bias priorities. Perception + decisions run on a throttled
  // `planInterval` (never every frame) so the roster can scale.
  ai: {
    planInterval: [0.3, 0.6], // seconds between a bot's re-decisions (throttled)
    awareness: 1600, // base sight radius; skill widens it a little (beginners still see far)
    skillTiers: [
      { name: "Beginner", max: 0.3 },
      { name: "Intermediate", max: 0.55 },
      { name: "Skilled", max: 0.8 },
      { name: "Elite", max: 1.01 },
    ],
    skillDistribution: { Beginner: 0.35, Intermediate: 0.3, Skilled: 0.25, Elite: 0.1 },
    personalities: ["hunter", "scavenger", "survivor", "guardianHunter", "explorer"],
  },

  // Arena Guardians: three heavy tanks that PATROL the center to stop early
  // rushing. They orbit within their territory, stop to fire, then resume — and
  // never chase players across the map.
  guardian: {
    count: 3,
    hp: 600,
    radius: 40, // larger than a normal tank
    speed: 46, // slow patrol pace
    turnRate: 3,
    color: 0x9a3b3b, // menacing dark red (still a tank shape, "looks like a player")
    fireRate: 2.2, // slow reload
    bulletDamage: 36, // high damage
    bulletSpeed: 360, // slow bullets
    bulletLife: 3.0,
    contactDamage: 30,
    range: 1200, // engages targets within this distance
    homeRadius: 900, // hard territory bound — steers back if pushed past this
    patrolRadius: 460, // orbit distance from center while patrolling
    patrolTurn: 0.32, // patrol angular speed (rad/sec)
  },

  // Toxic fog: a safe circle that shrinks in TIMED STAGES (hold, then contract,
  // repeat) so players can plan rotations, and STOPS at a final battle zone
  // (finalRadius) — the match ends through combat, not endless fog. Outside the
  // safe zone = damage over time.
  fog: {
    startRadius: arenaHalf * 1.45, // covers ~the whole map at the start
    finalRadius: 1150, // the fog stops here (large enough for a final fight)
    stages: 6, // number of shrink steps from start -> final
    holdTime: 15, // seconds the zone holds still before each shrink (minimap counter)
    shrinkTime: 8, // seconds each shrink transition takes (moves slowly, survivable)
    dps: 12, // damage per second while outside the safe zone
    color: 0xa64bff, // toxic purple edge
  },

  // Cosmetics: pick the player's tank body color. Purely visual.
  // Tank COLORS. Index 0 (Blue) is the default: always available, can't be locked
  // (the guaranteed fallback). Every other color unlocks through the Iron Path.
  // `gradient` [c1, c2] + `dir` make an FX gradient body (Aurora, Titanium).
  cosmetics: [
    { name: "Blue", color: 0x00b0e9 }, // 0 — default starting color
    { name: "Green", color: 0x39c05b }, // 1  (L7)
    { name: "Yellow", color: 0xf4d03f }, // 2  (L13)
    { name: "Rose", color: 0xe0567f }, // 3  (L22)
    { name: "Purple", color: 0x9b4dff }, // 4  (L38)
    { name: "Azure", color: 0x5112c7 }, // 5  (L44)
    { name: "Tomato Red", color: 0xeb4444 }, // 6  (L49)
    { name: "Crimson", color: 0xb2172b }, // 7  (L51)
    { name: "Aurora", color: 0x2f9a86, gradient: [0x5335fc, 0x00cc50], dir: "tl-br", fx: true }, // 8 (L59)
    { name: "Titanium", color: 0x9a9a9a, gradient: [0x595959, 0xeeeeee], dir: "tr-bl", fx: true }, // 9 (bundle)
  ],

  // Wraps: a pattern drawn INSIDE the (still circular) tank body. `pattern` keys
  // render/wraps.js. Index 0 (None) is the always-available default.
  wraps: [
    { name: "None", pattern: "none" }, // 0
    { name: "Camo", pattern: "camo" }, // 1  (L3)
    { name: "Carbon", pattern: "carbon" }, // 2  (L11)
    { name: "Stripes", pattern: "striped" }, // 3  (L27)
    { name: "Lightning", pattern: "lightning" }, // 4  (L34)
    { name: "Metal", pattern: "metal", fx: false }, // 5  (bundle) — diamond-plate
  ],

  // Trails: a cosmetic trail left behind while moving. `style` keys the emitter in
  // Game.#emitTrail. Index 0 (None) is the always-available default.
  trails: [
    { name: "None", style: "none" }, // 0
    { name: "Smoke", style: "smoke", color: 0x8a8f99 }, // 1  (L4)
    { name: "Sparks", style: "spark", color: 0xffd24a }, // 2  (L14)
    { name: "Hologram", style: "hologram", color: 0x4ad6ff }, // 3  (L23)
    { name: "Squares", style: "squares", color: 0x4aa3ff }, // 4  (L39)
    { name: "Rainbow", style: "rainbow" }, // 5  (L46)
    { name: "True Sparks", style: "trueSparks", fx: true }, // 6  (bundle)
  ],

  // Kill FX: an effect spawned ONLY when the player defeats another tank. `fx`
  // keys Game.#killEffect. Index 0 (No Kill FX) is the always-available default.
  killFx: [
    { name: "No Kill FX", fx: "none" }, // 0 — default (disabled)
    { name: "Burst", fx: "burst" }, // 1  (L9)
    { name: "Explode", fx: "explosion" }, // 2  (L21)
    { name: "Dissolve", fx: "dissolve" }, // 3  (L43)
    { name: "Stars", fx: "stars" }, // 4  (L53)
  ],

  // Titles: a colored label above the player's name. Index 0 (No Title) is the
  // always-available "unequipped" state (never an Iron Path reward). Iron Path
  // titles follow; FX titles carry `fx:true` (+ optional `bold`). The last two are
  // ACHIEVEMENT rewards (see achievements.js / unlocks.js) — NOT on the Iron Path.
  titles: [
    { name: "No Title", color: 0x8a8f99, desc: "No title equipped.", none: true }, // 0
    { name: "Noob", color: 0x9aa0b0, desc: "Every legend starts here." }, // 1  (L1)
    { name: "Private", color: 0x9aa0b0, desc: "Iron Path level 5." }, // 2  (L5)
    { name: "Corporal", color: 0xb6bcc8, desc: "Iron Path level 15." }, // 3  (L15)
    { name: "Dedicated", color: 0x76d672, desc: "Iron Path level 20." }, // 4  (L20)
    { name: "Sergeant", color: 0x76d672, desc: "Iron Path level 25." }, // 5  (L25)
    { name: "True Player", color: 0x4aa3ff, desc: "Iron Path level 32." }, // 6  (L32)
    { name: "Major", color: 0x4aa3ff, desc: "Iron Path level 35." }, // 7  (L35)
    { name: "Unwavering", color: 0x9b6cff, desc: "Iron Path level 40." }, // 8  (L40)
    { name: "Lieutenant", color: 0x9b6cff, desc: "Iron Path level 45." }, // 9  (L45)
    { name: "Professional", color: 0xffd24a, desc: "Iron Path level 50." }, // 10 (L50)
    { name: "Iron Captain", color: 0x004fa3, desc: "Iron Path level 55.", bold: true, fx: true }, // 11 (L55)
    { name: "Chromatic", color: 0x488c73, desc: "Iron Path level 58.", fx: true }, // 12 (L58)
    { name: "Veteran", color: 0xffd24a, desc: "Iron General Bundle." }, // 13 (bundle)
    { name: "Titanium General", color: 0x849091, desc: "Iron General Bundle.", bold: true, fx: true }, // 14 (bundle)
    { name: "Guardian Slayer", color: 0xffd24a, desc: "Killed 3 Arena Guardians." }, // 15 (achievement)
    { name: "Champion", color: 0xe23b50, desc: "Won a Battle Royale match." }, // 16 (achievement)
  ],

  // Procedural walls: impassable rectangles in random clusters. They block
  // movement and bullets; spawning avoids the center and the player's drop and
  // leaves routes (see Game.#spawnWalls).
  walls: {
    clusters: 7, // number of wall clusters
    perCluster: [2, 4], // rectangles per cluster (min,max)
    size: [120, 420], // rectangle side length range (world units)
    avoidCenter: 1400, // keep clusters this far from the arena center
    minPlayerDist: 900, // keep clusters away from the player's outer-ring drop
  },

  // Weapons. Index 0 (Standard) is always unlocked; the rest unlock through the
  // Iron Path (one per `ironPath.unlockEvery` levels, in this order). Every stat
  // lives here (no hardcoding in logic) — balanced around 100 HP.
  //
  //   turret       — visual barrel layout (render/turret.js), shared by the tank
  //                  and the Arsenal previews so the silhouette always matches.
  //   cooldown     — seconds between shots (absolute).
  //   recoil       — barrel kick-back distance on fire (feel; per weapon).
  //   bulletSpeed  — projectile speed (px/s). bulletRadius/bulletLife size + range.
  //   spread       — random aim deviation per shot (radians). 0 = pin-accurate.
  //   moveMul      — passive movement multiplier.
  //   armorPen     — fraction the target's armor is IGNORED (Sniper).
  //   fovMul       — camera zoom while equipped (<1 = see farther; Sniper).
  //   fireMode     — "shots" (default) | "laser" | "rocket" | "burst".
  //   shots[]      — one entry per bullet fired: { perp, angle, damage, speedMul,
  //                  radiusMul, delay, muzzle }. perp = sideways offset (px);
  //                  angle = offset from facing (rad); delay = stagger (s).
  //   burst        — { count, interval } for burst-fire weapons.
  //   laser/rocket — mode-specific data (see Game.js).
  //
  // Order + specs follow the authoritative weapon PDF (Core Weapon Concepts).
  weapons: [
    // 0 — Standard: the balanced baseline everything else is proportioned against.
    {
      name: "Standard", turret: "single", cooldown: 0.18, recoil: 6,
      bulletSpeed: 780, bulletRadius: 7, bulletLife: 1.2, spread: 0.03,
      shots: [{ damage: 15 }],
    },
    // 1 — Dual Barrel: two standard barrels firing simultaneously, FULL standard
    //     damage + size each (per PDF — not weakened).
    {
      name: "Dual Barrel", turret: "dual", cooldown: 0.2, recoil: 6,
      bulletSpeed: 780, bulletRadius: 7, bulletLife: 1.15, spread: 0.03,
      shots: [{ perp: -15, damage: 15 }, { perp: 15, damage: 15 }],
    },
    // 2 — Machine Gun: trapezoid barrel, high fire rate, low accuracy (bullets
    //     spray toward the general area).
    {
      name: "Machine Gun", turret: "wide", cooldown: 0.09, recoil: 2,
      bulletSpeed: 740, bulletRadius: 7, bulletLife: 0.9, spread: 0.15, muzzle: 54,
      shots: [{ damage: 15 }],
    },
    // 3 — Flank: a full standard barrel front AND back (fires both ways).
    {
      name: "Flank", turret: "flank", cooldown: 0.18, recoil: 6,
      bulletSpeed: 780, bulletRadius: 7, bulletLife: 1.2, spread: 0.03,
      shots: [{ damage: 15 }, { angle: Math.PI, damage: 15, muzzle: 50 }],
    },
    // 4 — Sniper: long barrel, high-speed high-damage rounds, long cooldown, long
    //     range + widened FOV; armor-piercing. Rewards aim.
    {
      name: "Sniper", turret: "long", cooldown: 0.28, recoil: 9, armorPen: 0.15, fovMul: 0.82,
      bulletSpeed: 975, bulletRadius: 7, bulletLife: 1.7, spread: 0, muzzle: 92,
      shots: [{ damage: 35 }],
    },
    // 5 — Triple Barrel: three standard barrels ANGLED up / middle / down (a fan,
    //     not three straight ahead).
    {
      name: "Triple Barrel", turret: "triple", cooldown: 0.2, recoil: 6,
      bulletSpeed: 780, bulletRadius: 7, bulletLife: 1.15, spread: 0.015,
      shots: [{ angle: -0.32, damage: 13 }, { angle: 0, damage: 13 }, { angle: 0.32, damage: 13 }],
    },
    // 6 — Rocketeer: a slow arrowhead rocket that TRAILS small bullets out its
    //     back as it flies; SHIFT detonates every live rocket into pellet rings.
    //     Small bullets deal less than standard damage.
    {
      name: "Rocketeer", turret: "rocket", cooldown: 0.7, recoil: 12, fireMode: "rocket", muzzle: 66,
      rocket: {
        damage: 48, speed: 340, radius: 13, life: 2.4,
        trail: { interval: 0.09, damage: 6, speed: 190, size: 4 }, // rear-fired mini bullets
        detonate: {
          explodeRadius: 44, bonusDamage: 6, knockback: 200,
          layers: [
            { count: 8, damage: 9, speed: 300, size: 5 }, // inner ring
            { count: 10, damage: 9, speed: 430, size: 5 }, // outer ring
          ],
        },
      },
    },
    // 7 — Penta Shot: 5-barrel fan with sizes DECREASING from the middle out.
    //     Staggered: middle first, inner pair 2nd, outer pair last. Smaller
    //     bullets deal slightly less; all share the same speed.
    {
      name: "Penta Shot", turret: "penta", cooldown: 0.26, recoil: 6,
      bulletSpeed: 760, bulletRadius: 7, bulletLife: 1.0, spread: 0.02,
      shots: [
        { angle: 0, damage: 13, delay: 0, radiusMul: 1.0 },
        { angle: -0.2, damage: 11, delay: 0.05, radiusMul: 0.82 },
        { angle: 0.2, damage: 11, delay: 0.05, radiusMul: 0.82 },
        { angle: -0.4, damage: 9, delay: 0.1, radiusMul: 0.66 },
        { angle: 0.4, damage: 9, delay: 0.1, radiusMul: 0.66 },
      ],
    },
    // 8 — Burst Rifle (replaces Railgun): one clean barrel that fires THREE
    //     standard bullets in rapid succession, then a short reload. Moderate
    //     everything — a core aim-and-timing weapon.
    {
      name: "Burst Rifle", turret: "burst", cooldown: 0.9, recoil: 5, fireMode: "burst", muzzle: 74,
      bulletSpeed: 770, bulletRadius: 7, bulletLife: 1.3, spread: 0.04,
      burst: { count: 3, interval: 0.08 },
      shots: [{ damage: 13 }],
    },
    // 9 — Cannoneer: a huge slow shell doing INSANE damage; low fire rate, very
    //     high recoil.
    {
      name: "Cannoneer", turret: "cannon", cooldown: 1.15, recoil: 16,
      bulletSpeed: 380, bulletRadius: 20, bulletLife: 1.7, spread: 0.02,
      shots: [{ damage: 55 }],
    },
    // 10 — Laser Rifle: a constant finite-range beam. Overheats after `heatTime`
    //     of use (barrel glows red), then must `coolTime` before firing again; an
    //     early release incurs `interruptCooldown`.
    {
      name: "Laser Rifle", turret: "laser", cooldown: 0, recoil: 0, fireMode: "laser", muzzle: 82,
      laser: {
        tickDamage: 4, tickRate: 0.02, range: 1000, width: 7, moveMul: 0.65, armorVuln: 0.18,
        heatTime: 3, coolTime: 2, interruptCooldown: 0.8,
      },
    },
  ],

  // Iron Path: a 1..maxLevel meta-progression. A weapon unlocks every
  // `unlockEvery` levels (level 6 -> weapon 1, level 12 -> weapon 2, ...).
  // XP is earned per match (kills + survival + a win bonus) and persisted on the
  // Profile; `level = floor(totalXp / xpPerLevel) + 1`, capped at maxLevel.
  ironPath: {
    maxLevel: 60,
    unlockEvery: 6,
    xpPerLevel: 600, // total XP needed for each level step
    xpPerKill: 60,
    xpPerSecond: 1, // survival reward
    winBonus: 500,
    // The AUTHORITATIVE concrete reward for every level 1..60 (keyed by level).
    // `type` is one of: title | money | wrap | trail | killfx | color | weapon |
    // bundle. `index` points into the matching GAME array; `amount` is $ for money.
    // Weapons ALSO derive from `unlockEvery` (isWeaponUnlocked) — the two agree
    // (weapon i unlocks at level 6·i). Achievement titles are NOT listed here.
    rewards: {
      1: { type: "title", index: 1 }, // [Noob]
      2: { type: "money", amount: 30 },
      3: { type: "wrap", index: 1 }, // Camo
      4: { type: "trail", index: 1 }, // Smoke
      5: { type: "title", index: 2 }, // [Private]
      6: { type: "weapon", index: 1 }, // Dual Barrel
      7: { type: "color", index: 1 }, // Green
      8: { type: "money", amount: 15 },
      9: { type: "killfx", index: 1 }, // Burst
      10: { type: "money", amount: 45 },
      11: { type: "wrap", index: 2 }, // Carbon
      12: { type: "weapon", index: 2 }, // Machine Gun
      13: { type: "color", index: 2 }, // Yellow
      14: { type: "trail", index: 2 }, // Sparks
      15: { type: "title", index: 3 }, // [Corporal]
      16: { type: "money", amount: 45 },
      17: { type: "money", amount: 30 },
      18: { type: "weapon", index: 3 }, // Flank
      19: { type: "money", amount: 30 },
      20: { type: "title", index: 4 }, // [Dedicated]
      21: { type: "killfx", index: 2 }, // Explode
      22: { type: "color", index: 3 }, // Rose
      23: { type: "trail", index: 3 }, // Hologram
      24: { type: "weapon", index: 4 }, // Sniper
      25: { type: "title", index: 5 }, // [Sergeant]
      26: { type: "money", amount: 30 },
      27: { type: "wrap", index: 3 }, // Stripes
      28: { type: "money", amount: 20 },
      29: { type: "money", amount: 50 },
      30: { type: "weapon", index: 5 }, // Triple Barrel
      31: { type: "money", amount: 45 },
      32: { type: "title", index: 6 }, // [True Player]
      33: { type: "money", amount: 30 },
      34: { type: "wrap", index: 4 }, // Lightning
      35: { type: "title", index: 7 }, // [Major]
      36: { type: "weapon", index: 6 }, // Rocketeer
      37: { type: "money", amount: 20 },
      38: { type: "color", index: 4 }, // Purple
      39: { type: "trail", index: 4 }, // Squares
      40: { type: "title", index: 8 }, // [Unwavering]
      41: { type: "money", amount: 55 },
      42: { type: "weapon", index: 7 }, // Penta Shot
      43: { type: "killfx", index: 3 }, // Dissolve
      44: { type: "color", index: 5 }, // Azure
      45: { type: "title", index: 9 }, // [Lieutenant]
      46: { type: "trail", index: 5 }, // Rainbow
      47: { type: "money", amount: 30 },
      48: { type: "weapon", index: 8 }, // Burst Rifle
      49: { type: "color", index: 6 }, // Tomato Red
      50: { type: "title", index: 10 }, // [Professional]
      51: { type: "color", index: 7 }, // Crimson
      52: { type: "money", amount: 60 },
      53: { type: "killfx", index: 4 }, // Stars
      54: { type: "weapon", index: 9 }, // Cannoneer
      55: { type: "title", index: 11 }, // [Iron Captain] (FX)
      56: { type: "money", amount: 100 },
      57: { type: "money", amount: 75 },
      58: { type: "title", index: 12 }, // [Chromatic] (FX)
      59: { type: "color", index: 8 }, // Aurora (FX)
      // Level 60 — the Iron General Bundle: SEVEN items unlocked at once.
      60: {
        type: "bundle",
        name: "Iron General Bundle",
        items: [
          { type: "weapon", index: 10 }, // Laser Rifle
          { type: "money", amount: 200 },
          { type: "title", index: 13 }, // [Veteran]
          { type: "title", index: 14 }, // [Titanium General] (FX)
          { type: "color", index: 9 }, // Titanium (FX)
          { type: "trail", index: 6 }, // True Sparks (FX)
          { type: "wrap", index: 5 }, // Metal
        ],
      },
    },
  },

  // Loot crates: world containers holding 3 upgrade items (mostly normals, with
  // a small chance of a special). The player opens one by touching it; it grants
  // all 3 at once. Counts are per rarity zone (outer -> center). Crates outside
  // the toxic fog are consumed by it (so loot thins as the safe zone shrinks).
  crate: {
    radius: 44, // bigger than a player tank (radius 28)
    hp: 60, // crates are SHOT open — player bullets chip this down to 0
    items: 3,
    specialChance: 0.25, // chance any one item in a crate is a special
    perZone: [2, 4, 4, 6], // [center, middle, inner, outside] — matches ZONES order
  },

  // Endgame pressure: as the roster thins the fog accelerates and forces a
  // final confrontation. Counts are total entities still alive (player + bots).
  endgame: {
    compressAt: 10, // <= this many alive: fog shrinks faster
    compressMul: 1.7,
    finalAt: 5, // <= this many alive: final phase (fog dominates, loot rare)
    finalMul: 2.6,
  },
};
