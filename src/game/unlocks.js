// Which cosmetics a profile has unlocked, DERIVED from progression (Iron Path
// level + completed achievements) — never stored, so it can't go stale.
//
//   colors  — all unlocked (the base palette)
//   wraps   — None (0) + any Iron Path wrap reward at/under the current level
//   trails  — None (0) + any Iron Path trail reward at/under the current level
//   killFx  — Burst (0) only (no early source yet)
//   titles  — Iron Path title rewards (Noob L1, Rookie L5) + achievement titles

import { GAME } from "../config.js";
import { ACHIEVEMENTS } from "./achievements.js";

const REWARD_TYPE = { wraps: "wrap", trails: "trail", titles: "title" };

// Returns a Set of unlocked indices for a cosmetic category
// ("cosmetics" | "wraps" | "trails" | "killFx" | "titles").
// Every index available for a category (used by developer TEST mode).
const ALL = { cosmetics: "cosmetics", wraps: "wraps", trails: "trails", killFx: "killFx", titles: "titles" };

export function unlockedIndices(profile, category) {
  const set = new Set();

  // Developer TEST mode unlocks everything.
  if (profile.devUnlockAll && ALL[category]) {
    GAME[category].forEach((_, i) => set.add(i));
    return set;
  }

  if (category === "cosmetics") {
    GAME.cosmetics.forEach((_, i) => set.add(i));
    return set;
  }

  // The "none"/default option is always available for these.
  if (category === "wraps" || category === "trails" || category === "killFx") set.add(0);

  // Iron Path rewards earned up to the current level.
  const level = profile.ironPathLevel;
  const wantType = REWARD_TYPE[category];
  if (wantType) {
    for (const [lvl, r] of Object.entries(GAME.ironPath.rewards || {})) {
      if (Number(lvl) <= level && r.type === wantType && r.index != null) set.add(r.index);
    }
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
