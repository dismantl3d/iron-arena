// The player's collected upgrades for the current match. Normals are stored as
// typeKey -> rarityIndex (one per type, highest rarity wins — no stacking).
// Specials are an ordered list, max 2; collecting a 3rd drops the oldest.

export class UpgradeState {
  constructor() {
    this.normals = {}; // e.g. { bulletSpeed: 3 }
    this.specials = []; // e.g. ["healing", "sentry"]
  }

  // Returns true if this changed anything (so callers can re-apply stats).
  collectNormal(typeKey, rarityIndex) {
    const current = this.normals[typeKey];
    if (current === undefined || rarityIndex > current) {
      this.normals[typeKey] = rarityIndex; // higher rarity replaces lower
      return true;
    }
    return false; // collecting same/lower rarity is ignored
  }

  // Equip a special. Max 2; a 3rd replaces the oldest (allow replacement).
  collectSpecial(key) {
    if (this.specials.includes(key)) return false;
    if (this.specials.length < 2) this.specials.push(key);
    else this.specials = [this.specials[1], key]; // drop oldest, keep order
    return true;
  }

  hasSpecial(key) {
    return this.specials.includes(key);
  }
}
