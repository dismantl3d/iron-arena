// The persistent ACCOUNT model + all authoritative progression logic. Pure over a
// plain account record (no DB, no sockets) so it's trivially testable and the store
// backend is swappable. The server is the ONLY place XP / currency / unlocks / stats
// change — clients never mutate these directly.
//
// Player level == Iron Path level (single progression curve, GAME.ironPath): we do
// NOT invent a parallel curve. XP is the existing Iron Path XP; levelForXp() derives
// the level; Iron Path rewards (weapons/cosmetics/currency) are GRANTED here, once
// per level (claimedRewards guards against duplicate currency/unlock claims).

import { levelForXp } from "../../src/game/IronPath.js";
import { GAME } from "../../src/config.js";
import {
  CATEGORIES, defaultUnlocks, defaultLoadout, defaultId, idFor, indexFor, itemCount,
  rewardGrantsForLevel, weaponUnlockAtLevel,
} from "./ids.js";
import { newAccountId, newToken, hashSecret } from "./auth.js";

// Client loadout field <-> account unlock category. (Client speaks "cosmetic" for
// color and "killFx" for kill FX; the account stores "colors"/"killfx".)
export const LOADOUT_FIELDS = { weapon: "weapons", cosmetic: "colors", wrap: "wraps", trail: "trails", killFx: "killfx", title: "titles" };

const emptyStats = () => ({ matchesPlayed: 0, matchesWon: 0, tanksDestroyed: 0, survivalTime: 0, xpEarned: 0 });

// Create a brand-new account. Returns { account, token } — the raw token is handed
// to the client ONCE and never stored (only its salted hash lives on the account).
export function createAccount({ displayName = "", seed = null } = {}) {
  const token = newToken();
  const { hash, salt } = hashSecret(token);
  const now = Date.now();
  const account = {
    id: newAccountId(),
    tokenHash: hash,
    tokenSalt: salt,
    displayName: sanitizeName(displayName),
    kind: "guest", // "guest" (token identity) | "registered" (username + password)
    username: null, // registered accounts only (display name stays separate)
    usernameLower: null, // case-insensitive uniqueness key
    passHash: null,
    passSalt: null,
    createdAt: now,
    lastSeen: now,
    xp: 0,
    currency: 0,
    claimedRewards: [], // Iron Path levels whose rewards have been granted
    unlocks: defaultUnlocks(), // { category: [id,...] } — always includes each default
    loadout: defaultLoadout(), // { category: id }
    stats: emptyStats(),
  };
  // Optionally seed a fresh account from a client's existing local (offline) profile
  // so migrating players keep their progress the first time they make an account.
  if (seed) applySeed(account, seed);
  // Grant all Iron Path rewards earned up to the (possibly seeded) current level,
  // then apply the seeded loadout against the now-granted unlocks.
  grantRewardsUpTo(account, levelForXp(account.xp));
  applySeededLoadout(account);
  return { account, token };
}

// Seed identity/progress from a trusted local profile snapshot on FIRST creation
// only (before any reward grant). XP/currency are taken as-is; loadout is applied
// after unlocks are granted (below), so unowned picks fall back safely.
function applySeed(account, seed) {
  if (typeof seed.username === "string") account.displayName = sanitizeName(seed.username);
  if (Number.isFinite(seed.ironPathXp)) account.xp = Math.max(0, Math.floor(seed.ironPathXp));
  if (Number.isFinite(seed.money)) account.currency = Math.max(0, Math.floor(seed.money));
  account._seedLoadout = { // applied after grants so unowned items fall back
    weapon: seed.weapon, cosmetic: seed.cosmetic, wrap: seed.wrap, trail: seed.trail, killFx: seed.killFx, title: seed.title,
  };
}

// Normalize the account into a well-formed shape after loading from storage (older
// rows / partial data get filled in). Keeps the schema forgiving + forward-safe.
export function normalize(account) {
  account.displayName = sanitizeName(account.displayName || "");
  account.kind = account.kind === "registered" ? "registered" : "guest";
  account.username = account.username || null;
  account.usernameLower = account.usernameLower || (account.username ? account.username.toLowerCase() : null);
  account.passHash = account.passHash || null;
  account.passSalt = account.passSalt || null;
  account.xp = Math.max(0, Math.floor(account.xp || 0));
  account.currency = Math.max(0, Math.floor(account.currency || 0));
  account.claimedRewards = Array.isArray(account.claimedRewards) ? account.claimedRewards : [];
  account.unlocks = account.unlocks && typeof account.unlocks === "object" ? account.unlocks : {};
  account.loadout = account.loadout && typeof account.loadout === "object" ? account.loadout : {};
  account.stats = { ...emptyStats(), ...(account.stats || {}) };
  const du = defaultUnlocks(), dl = defaultLoadout();
  for (const cat of CATEGORIES) {
    // Every category always includes its default id (Blue etc. can never be lost).
    const set = new Set([defaultId(cat), ...(Array.isArray(account.unlocks[cat]) ? account.unlocks[cat] : [])]);
    account.unlocks[cat] = [...set];
    if (!account.loadout[cat] || indexFor(cat, account.loadout[cat]) < 0) account.loadout[cat] = dl[cat];
    void du;
  }
  return account;
}

const sanitizeName = (n) => String(n ?? "").replace(/[\x00-\x1f]/g, "").trim().slice(0, 20);

// Add an id to a category's unlock set (idempotent).
function addUnlock(account, category, id) {
  if (!id) return false;
  const arr = account.unlocks[category] || (account.unlocks[category] = []);
  if (arr.includes(id)) return false;
  arr.push(id);
  return true;
}

// Grant every Iron Path reward for levels 1..level that hasn't been claimed yet
// (unlocks + currency + weapon-every-6). Idempotent via claimedRewards.
export function grantRewardsUpTo(account, level) {
  const gained = { currency: 0, unlocked: [] };
  for (let lvl = 1; lvl <= level; lvl++) {
    if (account.claimedRewards.includes(lvl)) continue;
    const { grants, currency } = rewardGrantsForLevel(lvl);
    for (const g of grants) if (addUnlock(account, g.category, g.id)) gained.unlocked.push(g);
    const wid = weaponUnlockAtLevel(lvl);
    if (wid && addUnlock(account, "weapons", wid)) gained.unlocked.push({ category: "weapons", id: wid });
    account.currency += currency;
    gained.currency += currency;
    account.claimedRewards.push(lvl);
  }
  return gained;
}

// Authoritatively award XP. Adds to the running total, levels up, and grants any
// newly-earned Iron Path rewards. Returns a summary for logging/telemetry.
export function grantXp(account, amount) {
  const amt = Math.max(0, Math.floor(amount || 0));
  const before = levelForXp(account.xp);
  account.xp += amt;
  account.stats.xpEarned += amt;
  const after = levelForXp(account.xp);
  const gained = grantRewardsUpTo(account, after);
  return { xp: amt, levelsGained: after - before, level: after, ...gained };
}

// Record a completed match into persistent stats (never match state — just totals).
export function recordMatch(account, { kills = 0, survival = 0, won = false } = {}) {
  account.stats.matchesPlayed += 1;
  if (won) account.stats.matchesWon += 1;
  account.stats.tanksDestroyed += Math.max(0, Math.floor(kills));
  account.stats.survivalTime += Math.max(0, Math.round(survival));
}

// Validate a REQUESTED loadout (client indices) against what the account owns, set
// the account's equipped loadout to the validated result, and return the applied
// INDICES (unowned picks fall back to the always-available default = index 0).
export function applyLoadoutIndices(account, requested = {}) {
  const applied = {};
  for (const [field, category] of Object.entries(LOADOUT_FIELDS)) {
    const reqIndex = requested[field];
    const reqId = reqIndex == null ? null : idFor(category, Math.floor(reqIndex));
    const owned = reqId && account.unlocks[category]?.includes(reqId);
    const id = owned ? reqId : defaultId(category);
    account.loadout[category] = id;
    applied[field] = indexFor(category, id);
  }
  return applied;
}

// Apply a seeded loadout (from account creation) once unlocks have been granted.
export function applySeededLoadout(account) {
  if (!account._seedLoadout) return;
  applyLoadoutIndices(account, account._seedLoadout);
  delete account._seedLoadout;
}

// Build the client-facing PROFILE (index-based, matching the existing client UI):
// identity + xp/level/currency + equipped loadout indices + unlocked index sets +
// stats. The client never receives the token hash or any secret.
export function toProfileWire(account) {
  const loadout = {};
  for (const [field, category] of Object.entries(LOADOUT_FIELDS)) loadout[field] = indexFor(category, account.loadout[category]);
  const unlocks = {};
  for (const cat of CATEGORIES) unlocks[cat] = (account.unlocks[cat] || []).map((id) => indexFor(cat, id)).filter((i) => i >= 0).sort((a, b) => a - b);
  return {
    accountId: account.id,
    kind: account.kind,
    username: account.username,
    displayName: account.displayName,
    xp: account.xp,
    level: levelForXp(account.xp),
    currency: account.currency,
    loadout,
    unlocks,
    stats: { ...account.stats },
  };
}

// Update the display name (cosmetic identity — NOT the account id). Returns true if changed.
export function setDisplayName(account, name) {
  const n = sanitizeName(name);
  if (n === account.displayName) return false;
  account.displayName = n;
  return true;
}

// DEV ONLY (gated by the server env, see IRON_DEV_UNLOCK): unlock every item and jump to
// the max Iron Path level — the server-side equivalent of the developer TEST button.
export function devUnlockAll(account) {
  const maxXp = GAME.ironPath.maxLevel * GAME.ironPath.xpPerLevel;
  if (account.xp < maxXp) grantXp(account, maxXp - account.xp);
  for (const cat of CATEGORIES) {
    const set = new Set(account.unlocks[cat] || []);
    for (let i = 0; i < itemCount(cat); i++) set.add(idFor(cat, i));
    account.unlocks[cat] = [...set];
  }
}
