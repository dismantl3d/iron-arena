// Per-lobby bot names, so the roster isn't 30 tanks all labelled "BOT". A name
// generator hands out unique callsigns for one match; create one per match and
// call it once per bot.

const FIRST = [
  "Iron", "Steel", "Rusty", "Turbo", "Shadow", "Blaze", "Viper", "Rogue", "Ghost", "Delta",
  "Omega", "Nova", "Echo", "Titan", "Havoc", "Rex", "Zephyr", "Fang", "Bolt", "Crimson",
  "Vortex", "Storm", "Ranger", "Comet", "Grim", "Onyx", "Sable", "Frost", "Diesel", "Maverick",
];
const LAST = [
  "Tank", "Hunter", "Wolf", "Striker", "Raider", "Baron", "Knight", "Runner", "Reaper", "Gunner",
  "Warden", "Pilot", "Ace", "Nomad", "Fury", "Duke", "Sarge", "Scout", "Bandit", "Crusher",
];

const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// Returns a function that yields a fresh unique name on each call.
export function makeNameGen() {
  const used = new Set();
  return () => {
    for (let i = 0; i < 40; i++) {
      const n = pick(FIRST) + pick(LAST) + (Math.random() < 0.4 ? Math.floor(10 + Math.random() * 89) : "");
      if (!used.has(n)) {
        used.add(n);
        return n;
      }
    }
    let n;
    do {
      n = "Tank" + Math.floor(Math.random() * 9999);
    } while (used.has(n));
    used.add(n);
    return n;
  };
}
