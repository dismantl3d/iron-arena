// Stable item IDs for accounts. The GAME config arrays are INDEX-based (the client
// UI speaks indices), but persistent account data must use STABLE, order-independent
// IDs so that appending new weapons/cosmetics later never re-maps what an existing
// account already owns. We derive a stable id per item from its name (slug), and map
// index <-> id per category. New items get new ids automatically; old ids survive
// config growth. Colors live under GAME.cosmetics; kill FX under GAME.killFx.
//
// The wire protocol stays index-based (no client change); this module is the single
// translation seam between "account owns IDs" and "client shows indices".

import { GAME } from "../../src/config.js";

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// account category -> the GAME array that defines its items.
const ARRAYS = {
  weapons: GAME.weapons,
  colors: GAME.cosmetics,
  wraps: GAME.wraps,
  trails: GAME.trails,
  killfx: GAME.killFx,
  titles: GAME.titles,
};

export const CATEGORIES = Object.keys(ARRAYS);

// Per-category id<->index tables (ids are name slugs; index 0 is the default item).
const IDS = {}; // category -> [id, ...] by index
const INDEX = {}; // category -> { id -> index }
for (const cat of CATEGORIES) {
  IDS[cat] = ARRAYS[cat].map((it, i) => `${cat}:${slug(it.name)}` || `${cat}:${i}`);
  INDEX[cat] = {};
  IDS[cat].forEach((id, i) => (INDEX[cat][id] = i));
}

export function idFor(category, index) {
  return IDS[category]?.[index] ?? null;
}
export function indexFor(category, id) {
  const i = INDEX[category]?.[id];
  return i == null ? -1 : i;
}
export function itemCount(category) {
  return IDS[category]?.length ?? 0;
}

// The always-available default item id (index 0) of each category: Blue color,
// None wrap/trail, No Kill FX, No Title, Standard weapon. These can never be lost.
export function defaultId(category) {
  return idFor(category, 0);
}

// A fresh account's unlocked sets: just the index-0 default of each category
// (Standard weapon + Blue + None/None/No-Kill-FX/No-Title). Iron Path grants layer on.
export function defaultUnlocks() {
  const u = {};
  for (const cat of CATEGORIES) u[cat] = [defaultId(cat)];
  return u;
}

// A fresh account's equipped loadout: the default item of each category.
export function defaultLoadout() {
  const l = {};
  for (const cat of CATEGORIES) l[cat] = defaultId(cat);
  return l;
}

// Map an Iron Path reward `type` to an account unlock category (or null for money).
const REWARD_CATEGORY = { title: "titles", wrap: "wraps", trail: "trails", killfx: "killfx", color: "colors", weapon: "weapons" };

// Everything a single Iron Path level's reward grants: a list of { category, id }
// unlocks and a currency amount. Bundles unpack their items. (Money-only rewards
// return just currency.) Weapons ALSO derive from unlockEvery — folded in by the
// caller via weaponUnlockAtLevel so the two agree.
export function rewardGrantsForLevel(level) {
  const r = GAME.ironPath.rewards?.[level];
  const grants = [];
  let currency = 0;
  const apply = (rr) => {
    if (!rr) return;
    if (rr.type === "money") currency += rr.amount || 0;
    else if (rr.type === "bundle") (rr.items || []).forEach(apply);
    else {
      const cat = REWARD_CATEGORY[rr.type];
      if (cat && rr.index != null) { const id = idFor(cat, rr.index); if (id) grants.push({ category: cat, id }); }
    }
  };
  apply(r);
  return { grants, currency };
}

// The weapon (as an id) that unlocks at exactly this level via unlockEvery, or null.
// (Weapon i unlocks at level unlockEvery*i; weapon 0 is free at level 1.)
export function weaponUnlockAtLevel(level) {
  const every = GAME.ironPath.unlockEvery;
  if (level < every || level % every !== 0) return null;
  const wi = level / every; // weapon index
  return idFor("weapons", wi);
}

// The title id an achievement grants (or null), by achievement reward.title index.
export function achievementTitleId(titleIndex) {
  return titleIndex == null ? null : idFor("titles", titleIndex);
}
