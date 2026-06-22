// Global engine + visual + gameplay constants. Keep tunable values here, not
// scattered in code, so balance/feel can be adjusted in one place.

export const COLORS = {
  background: 0x14141a, // outside the arena (darker void)
  arenaFloor: 0x1e1e26, // the playable area
  grid: 0x2c2c38,
  arenaBorder: 0x3a3a48,

  tankBody: 0x00b0e9, // player blue
  tankBarrel: 0x9aa0a6,

  hpBg: 0x2a2a2a,
  hpFill: 0x76d672, // health-bar green

  xpFill: 0xffd24a, // XP bar / orbs gold
  xpOrb: 0x8be0ff,
  xpBg: 0x2a2a2a,

  hitSpark: 0xffe08a, // bullet-impact particles
  hudText: 0xffffff,
  hudDim: 0x9aa0b0, // secondary HUD text

  damageText: 0xffe8a0,
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
  },

  // Base player stats. Upgrades are applied on top of these (see `upgrades`).
  player: {
    maxHp: 100,
    speed: 280,
    turnRate: 16, // barrel aim responsiveness
    fireRate: 0.16, // seconds between shots
    contactInvuln: 0.7, // i-frames after taking contact damage
  },

  // Base bullet stats (damage/speed are raised by upgrades).
  bullet: { speed: 780, radius: 7, life: 1.2, damage: 25 },

  // Bots: AI tanks identical to the player (same size/look/bullets). In the
  // battle-royale loop the population is FIXED at match start (no respawns).
  bot: {
    hp: 60,
    speed: 150,
    turnRate: 9, // turret turn smoothness (a touch slower than the player)
    contactDamage: 12,
    score: 100, // awarded per bot killed
    fireRate: 1.3, // seconds between a bot's shots
    bulletDamage: 8, // bot bullets are weak (placeholder shooting)
    bulletSpeed: 640,
    bulletLife: 1.2,
    separation: 90, // anti-clump spacing in world units
    directionInterval: [2, 4.5], // seconds between wander heading changes
    levelMin: 1,
    levelMax: 3, // bot.level is set in this range, no effect yet
    label: "BOT", // username placeholder shown above each bot
  },

  // Battle royale loop: population is fixed at match start (1 player + bots up
  // to matchSize), no new spawns after, deaths permanent, last tank standing wins.
  match: {
    countdown: 30, // seconds in the waiting room before the match starts
    waitingBots: 6, // bots shown idling in the waiting room
    matchSize: 30, // total roster (player + bots) when the match begins
  },

  // Arena Guardians: three heavy tanks at the center to stop early rushing.
  guardian: {
    count: 3,
    hp: 600,
    radius: 40, // larger than a normal tank
    speed: 38, // slow
    turnRate: 3,
    color: 0x9a3b3b, // menacing dark red (still a tank shape, "looks like a player")
    fireRate: 2.2, // slow reload
    bulletDamage: 36, // high damage
    bulletSpeed: 360, // slow bullets
    bulletLife: 3.0,
    contactDamage: 30,
    range: 1200, // engages targets within this distance
    homeRadius: 700, // patrols within this distance of center
  },

  // Toxic fog: a shrinking safe circle. Outside it = damage over time. Prevents
  // camping and forces the fight inward.
  fog: {
    startRadius: arenaHalf * 1.45, // covers ~the whole map at the start
    minRadius: 500, // smallest the safe zone gets
    shrinkRate: 70, // world units per second the safe radius contracts
    dps: 9, // damage per second while outside the safe zone
    color: 0xa64bff, // toxic purple edge
  },

  // Cosmetics: pick the player's tank body color. Purely visual.
  cosmetics: [
    { name: "Aqua", color: 0x00b0e9 },
    { name: "Lime", color: 0x76d672 },
    { name: "Magenta", color: 0xc2497f },
    { name: "Gold", color: 0xffd24a },
    { name: "Violet", color: 0x9b6cff },
  ],

  // Weapons (placeholder loadouts). `barrels` fires that many bullets with a
  // small spread; the *Mul fields scale the player's fire rate / damage / speed.
  weapons: [
    { name: "Standard", barrels: 1 },
    { name: "Twin", barrels: 2, fireRateMul: 1.15 },
    { name: "Sniper", barrels: 1, fireRateMul: 1.8, damageMul: 1.6, bulletSpeedMul: 1.4 },
  ],
};
