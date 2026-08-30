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
    // Online account id (null offline). When set, this Profile mirrors the SERVER-
    // authoritative account (progression is decided server-side; this is a cache).
    this.accountId = data.accountId || null;
    this.online = false; // true while an authoritative account is loaded this session
  }

  // Adopt the SERVER's authoritative account profile (Phase 14.2 Step 7). The server
  // owns XP/currency/unlocks/loadout; the client mirrors them so the existing menu +
  // Iron Path + cosmetics panels reflect the account. Unlocks stay DERIVED from XP
  // (unlocks.js) — server grants match that derivation, so no client change is needed.
  applyServerProfile(wire) {
    if (!wire) return;
    this.accountId = wire.accountId ?? this.accountId;
    this.online = true;
    if (typeof wire.displayName === "string" && wire.displayName) this.username = wire.displayName;
    if (Number.isFinite(wire.xp)) this.ironPathXp = wire.xp;
    if (Number.isFinite(wire.currency)) this.money = wire.currency;
    const L = wire.loadout || {};
    if (Number.isFinite(L.weapon)) this.weapon = L.weapon;
    if (Number.isFinite(L.cosmetic)) this.cosmetic = L.cosmetic;
    if (Number.isFinite(L.wrap)) this.wrap = L.wrap;
    if (Number.isFinite(L.trail)) this.trail = L.trail;
    if (Number.isFinite(L.killFx)) this.killFx = L.killFx;
    if (Number.isFinite(L.title)) this.title = L.title;
    this.serverStats = wire.stats || null; // persistent match stats (for the profile UI)
    this.save();
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
    // Grant any Iron Path CURRENCY rewards for the levels just reached — including
    // the money inside the Level 60 bundle (the caller persists via save()).
    for (let lvl = before + 1; lvl <= after; lvl++) {
      const r = GAME.ironPath.rewards?.[lvl];
      if (!r) continue;
      if (r.type === "money") this.money += r.amount;
      else if (r.type === "bundle") for (const it of r.items || []) if (it.type === "money") this.money += it.amount;
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
          accountId: this.accountId,
        }),
      );
    } catch {
      // ignore storage failures (private mode, etc.)
    }
  }
}
