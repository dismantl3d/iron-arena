// Achievements locker: a list of achievement cards; clicking one opens a detail
// view (title / description / reward / progress / completed state). Opening the
// panel marks completed achievements as "seen" (clears the menu badge) via the
// onSeen callback so GameFlow can persist + refresh the menu.

import { el, hexToCss } from "./dom.js";
import { GAME } from "../config.js";
import { ACHIEVEMENTS } from "../game/achievements.js";
import { achievementProgress, markAchievementsSeen } from "../game/Progression.js";
import { sharedTooltip } from "./Tooltip.js";

const GOLD = "#ffd24a";

export class AchievementsPanel {
  // onSeen() — fired on open so the caller can persist + clear the badge.
  constructor(profile, onClose, onSeen) {
    this.profile = profile;
    this.onSeen = onSeen;
    this.tip = sharedTooltip();

    this.list = el("div", { class: "ia-ach-list" });
    this.detail = el("div", { class: "ia-ach-detail ia-hidden" });

    this.card = el("div", { class: "ia-panel ia-ach-panel" }, [
      el("h2", { text: "ACHIEVEMENTS" }),
      this.list,
      this.detail,
      el("button", { class: "ia-btn", text: "Back", on: { click: () => onClose() } }),
    ]);
    this.root = el("div", { class: "ia-overlay ia-scrim ia-hidden" }, [this.card]);
    document.body.appendChild(this.root);
  }

  show() {
    this.#renderList();
    this.#showList();
    this.root.classList.remove("ia-hidden");
    markAchievementsSeen(this.profile);
    this.onSeen?.();
  }
  hide() {
    this.tip.hide();
    this.root.classList.add("ia-hidden");
  }

  #showList() {
    this.tip.hide();
    this.list.classList.remove("ia-hidden");
    this.detail.classList.add("ia-hidden");
  }

  // Reward cards (same card style as the Arsenal). Each shows the reward value +
  // its type, and a hover tooltip (name + type).
  #rewardCards(reward) {
    const cards = [];
    if (reward.money) cards.push(this.#card(`$${reward.money}`, "Money", GOLD));
    if (reward.title != null) {
      const t = GAME.titles[reward.title];
      cards.push(this.#card(`[${t.name}]`, "Title", hexToCss(t.color)));
    }
    return cards;
  }

  #card(name, type, color) {
    const value = el("div", { class: "ia-rc-value", text: name });
    if (color) value.style.color = color;
    const card = el("div", { class: "ia-reward-card" }, [
      value,
      el("div", { class: "ia-rc-type", text: type }),
    ]);
    card.addEventListener("mouseenter", () => this.tip.show(card, { name, type }));
    card.addEventListener("mouseleave", () => this.tip.hide());
    return card;
  }

  #renderList() {
    this.list.replaceChildren();
    for (const a of ACHIEVEMENTS) {
      const { progress, completed } = achievementProgress(this.profile, a.id);
      const status = el("div", {
        class: "ia-ach-status",
        text: completed ? "Completed" : `${progress} / ${a.goal}`,
      });
      if (completed) status.classList.add("ia-done");
      const cardEl = el(
        "div",
        { class: "ia-ach-card" + (completed ? " ia-done" : ""), on: { click: () => this.#showDetail(a) } },
        [el("div", { class: "ia-ach-name", text: a.name }), status],
      );
      this.list.appendChild(cardEl);
    }
  }

  #showDetail(a) {
    const { progress, completed } = achievementProgress(this.profile, a.id);
    const frac = Math.min(1, progress / a.goal);
    this.detail.replaceChildren(
      el("h3", { class: "ia-ach-dtitle", text: a.name }),
      el("p", { class: "ia-ach-ddesc", text: a.desc }),
      el("div", { class: "ia-ach-dreward" }, [
        el("span", { class: "ia-k", text: "Reward" }),
        el("div", { class: "ia-reward-cards" }, this.#rewardCards(a.reward)),
      ]),
      el("div", { class: "ia-ach-bar" }, [el("div", { class: "ia-ach-bar-fill", style: { width: `${frac * 100}%` } })]),
      el("div", {
        class: "ia-ach-state" + (completed ? " ia-done" : ""),
        text: completed ? "COMPLETED" : `${progress} / ${a.goal}`,
      }),
      el("button", { class: "ia-btn", text: "All Achievements", on: { click: () => this.#showList() } }),
    );
    this.list.classList.add("ia-hidden");
    this.detail.classList.remove("ia-hidden");
  }
}
