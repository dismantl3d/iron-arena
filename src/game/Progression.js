// Progression logic over the Profile: achievement progress/completion, reward
// granting (money + title unlock), and the "unseen completed" badge count. Pure
// functions so the Game and the UI share one source of truth. No persistence
// here — callers persist via profile.save().

import { ACHIEVEMENTS, achievementById } from "./achievements.js";

// Ensure a profile has a state record for an achievement.
function stateFor(profile, id) {
  if (!profile.achievements[id]) {
    profile.achievements[id] = { progress: 0, completed: false, seen: false };
  }
  return profile.achievements[id];
}

// Add progress to an achievement. If it newly completes, grant its reward and
// return the achievement def (so the caller can show a completion toast).
// Returns null otherwise.
export function recordAchievement(profile, id, amount = 1) {
  const def = achievementById(id);
  if (!def) return null;
  const st = stateFor(profile, id);
  if (st.completed) return null;

  st.progress = Math.min(def.goal, st.progress + amount);
  if (st.progress >= def.goal) {
    st.completed = true;
    st.seen = false;
    grantReward(profile, def.reward);
    return def;
  }
  return null;
}

// Apply an achievement's reward to the profile. Title unlocks are DERIVED from
// completed achievements (see unlocks.js), so only money is stored here.
function grantReward(profile, reward) {
  if (reward.money) profile.money += reward.money;
}

// How many completed achievements the player hasn't seen yet (menu badge).
export function unseenAchievementCount(profile) {
  return ACHIEVEMENTS.filter((a) => {
    const st = profile.achievements[a.id];
    return st && st.completed && !st.seen;
  }).length;
}

// Mark all completed achievements as seen (clears the badge).
export function markAchievementsSeen(profile) {
  for (const a of ACHIEVEMENTS) {
    const st = profile.achievements[a.id];
    if (st && st.completed) st.seen = true;
  }
}

// Read-only view of one achievement's state for the UI.
export function achievementProgress(profile, id) {
  const st = profile.achievements[id];
  return { progress: st?.progress || 0, completed: !!st?.completed };
}
