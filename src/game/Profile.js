// Profile holds the player's persistent identity + meta progression: username,
// chosen cosmetic + weapon, and accumulated Iron Path XP. Persisted to
// localStorage so it survives reloads (there's no server yet).

const KEY = "ironArena.profile";

export class Profile {
  constructor(data = {}) {
    this.username = data.username || "";
    this.cosmetic = data.cosmetic ?? 0; // index into GAME.cosmetics
    this.weapon = data.weapon ?? 0; // index into GAME.weapons
    this.ironPathXp = data.ironPathXp || 0;
  }

  // Falls back to "Unnamed Tank" when the username field is blank.
  get displayName() {
    return this.username.trim() || "Unnamed Tank";
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
          weapon: this.weapon,
          ironPathXp: this.ironPathXp,
        }),
      );
    } catch {
      // ignore storage failures (private mode, etc.)
    }
  }
}
