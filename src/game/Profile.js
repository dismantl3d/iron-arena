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
    // Account mode: the menu mirrors the SERVER account while `online` is true. The player's
    // offline (local) progression is stashed in `_local` and restored by useLocal(), so
    // switching to an online account never destroys local progress.
    this.online = !!data.online && !!data.local;
    this.accountKind = this.online ? data.accountKind || "guest" : null; // "guest" | "registered"
    this.accountName = this.online ? data.accountName || null : null; // registered username
    this._local = this.online ? data.local : null;
    this.serverStats = data.serverStats || null;
  }

  // Adopt the SERVER's authoritative account profile. The server owns XP/currency/unlocks/
  // loadout; the client mirrors them so the existing menu + Iron Path + cosmetics panels
  // reflect the account (unlocks stay DERIVED from XP — server grants match that derivation).
  // The first switch stashes the offline progression so it can be restored later.
  //   adoptLoadout: copy the account's equipped loadout (explicit login on a new device).
  //   Otherwise the player's live menu selection is kept (the server validates it on join).
  useAccount(wire, { adoptLoadout = false } = {}) {
    if (!wire) return;
    if (!this.online || !this._local) {
      this._local = { ironPathXp: this.ironPathXp, money: this.money, devUnlockAll: this.devUnlockAll };
    }
    this.online = true;
    this.accountId = wire.accountId ?? this.accountId;
    this.accountKind = wire.kind || "guest";
    this.accountName = wire.username || null;
    if (typeof wire.displayName === "string" && wire.displayName) this.username = wire.displayName;
    if (Number.isFinite(wire.xp)) this.ironPathXp = wire.xp;
    if (Number.isFinite(wire.currency)) this.money = wire.currency;
    this.devUnlockAll = false; // account unlocks are derived from the server's XP, never a local flag
    if (adoptLoadout) this.adoptLoadout(wire.loadout, false);
    this.serverStats = wire.stats || null; // persistent match stats (for the profile UI)
    this.save();
  }
  applyServerProfile(wire, opts) { this.useAccount(wire, opts); } // back-compat alias

  // Leave account mode (logout / offline play): restore the stashed local progression.
  useLocal() {
    if (this._local) Object.assign(this, this._local);
    this._local = null;
    this.online = false;
    this.accountKind = null;
    this.accountName = null;
    this.serverStats = null;
    this.save();
  }

  // Copy an equipped loadout (indices) into the profile — used for an explicit login and to
  // reflect the SERVER-VALIDATED loadout after joining a match.
  adoptLoadout(L, save = true) {
    if (!L) return;
    for (const f of ["weapon", "cosmetic", "wrap", "trail", "killFx", "title"]) if (Number.isFinite(L[f])) this[f] = L[f];
    if (save) this.save();
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
          online: this.online,
          accountKind: this.accountKind,
          accountName: this.accountName,
          local: this._local,
          serverStats: this.serverStats,
        }),
      );
    } catch {
      // ignore storage failures (private mode, etc.)
    }
  }
}
