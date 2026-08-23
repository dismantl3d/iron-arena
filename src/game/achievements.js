// Achievement definitions (pure data). Progress + completion live on the
// Profile (see game/Progression.js); rewards grant money and/or unlock a title
// (title index into GAME.titles). `goal` is the progress needed to complete.

export const ACHIEVEMENTS = [
  {
    id: "unstoppable",
    name: "Unstoppable",
    desc: "Kill 3 Arena Guardians in Battle Royale",
    goal: 3,
    reward: { title: 2 }, // [Guardian Slayer] (yellow)
  },
  {
    id: "first_blood",
    name: "A Moment to Cherish Forever",
    desc: "Kill your first tank",
    goal: 1,
    reward: { money: 10 },
  },
  {
    id: "victor",
    name: "The Victorious One",
    desc: "Win a Battle Royale match",
    goal: 1,
    reward: { money: 5, title: 3 }, // [Champion] (radish red)
  },
];

export function achievementById(id) {
  return ACHIEVEMENTS.find((a) => a.id === id) || null;
}
