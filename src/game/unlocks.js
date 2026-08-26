// Which cosmetics a profile has unlocked, DERIVED from progression (Iron Path
// level + completed achievements) — never stored, so it can't go stale.
//
// Index 0 of every category is the always-available default: Blue (colors),
// None (wraps/trails), No Kill FX (killFx), No Title (titles). Everything else
// comes from Iron Path rewards up to the current level (including the Level 60
// bundle's contents) plus achievement titles.

import { GAME } from "../config.js";
import { ACHIEVEMENTS } from "./achievements.js";

// UI category -> the reward `type` that unlocks it.
const REWARD_TYPE = { cosmetics: "color", wraps: "wrap", trails: "trail", killFx: "killfx", titles: "title" };
const ALL = { cosmetics: 1, wraps: 1, trails: 1, killFx: 1, titles: 1 };

export function unlockedIndices(profile, category) {
  const set = new Set();

  // Developer TEST mode unlocks everything.
  if (profile.devUnlockAll && ALL[category]) {
    GAME[category].forEach((_, i) => set.add(i));
    return set;
  }

  // Index 0 is always available for every category (Blue / None / No Title).
  set.add(0);

  const wantType = REWARD_TYPE[category];
  if (!wantType) return set;

  // Iron Path rewards earned up to the current level (bundles unpack their items).
  const level = profile.ironPathLevel;
  const add = (r) => {
    if (r.type === wantType && r.index != null) set.add(r.index);
  };
  for (const [lvl, r] of Object.entries(GAME.ironPath.rewards || {})) {
    if (Number(lvl) > level) continue;
    if (r.type === "bundle") r.items?.forEach(add);
    else add(r);
  }

  // Achievement title rewards.
  if (category === "titles") {
    for (const a of ACHIEVEMENTS) {
      const st = profile.achievements?.[a.id];
      if (st?.completed && a.reward?.title != null) set.add(a.reward.title);
    }
  }

  return set;
}

export function isUnlocked(profile, category, index) {
  return unlockedIndices(profile, category).has(index);
}
