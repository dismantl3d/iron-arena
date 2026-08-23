// Profile holds the player's persistent identity + meta progression: username,
// chosen cosmetic + weapon, and accumulated Iron Path XP. Persisted to
// localStorage so it survives reloads (there's no server yet).

import { levelForXp } from "./IronPath.js";
import { GAME } from "../config.js";

const KEY = "ironArena.profile";

export class Profile {
  constructor(data = {}) {
    this.username = data.username || "";
    this.cosmetic = data.cosmetic ?? 0; // index into GAME.cosmetics (color)
    this.wrap = data.wrap ?? 0; // index into GAME.wraps
    this.trail = data.trail ?? 0; // index into GAME.trails
    this.killFx = data.killFx ?? 0; // index into GAME.killFx
    this.title = data.title ?? 0; // index into GAME.titles
    this.weapon = data.weapon ?? 0; // index into GAME.weapons
    this.ironPathXp = data.ironPathXp || 0;
    this.money = data.money || 0; // currency ($), earned from achievements / future shop
    // Achievement state: { [id]: { progress, completed, seen } }.
    this.achievements = data.achievements || {};
    this.devUnlockAll = data.devUnlockAll || false; // developer TEST mode: everything unlocked
  }

  // Falls back to "Unnamed Tank" when the username field is blank.
  get displayName() {
    return this.username.trim() || "Unnamed Tank";
  }

  // Iron Path level derived from accumulated XP (see IronPath.js).
  get ironPathLevel() {
    return levelForXp(this.ironPathXp);
  }

  // Award match XP. Returns the level gained (0 if none) so callers can flag a
  // new weapon unlock.
  addIronPathXp(amount) {
    const before = this.ironPathLevel;
    this.ironPathXp += Math.max(0, Math.round(amount));
    const after = this.ironPathLevel;
    // Grant any Iron Path CURRENCY rewards for the levels just reached (the
    // caller persists via save()).
    for (let lvl = before + 1; lvl <= after; lvl++) {
      const r = GAME.ironPath.rewards?.[lvl];
      if (r?.type === "money") this.money += r.amount;
    }
    return after - before;
  }

  static load() {
    try {
      return new Profile(JSON.parse(localStorage.getItem(KEY)) || {});
    } catch {
      return new Profile();
    }
  }

  save() {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          username: this.username,
          cosmetic: this.cosmetic,
          wrap: this.wrap,
          trail: this.trail,
          killFx: this.killFx,
          title: this.title,
          weapon: this.weapon,
          ironPathXp: this.ironPathXp,
          money: this.money,
          achievements: this.achievements,
          devUnlockAll: this.devUnlockAll,
        }),
      );
    } catch {
      // ignore storage failures (private mode, etc.)
    }
  }
}
