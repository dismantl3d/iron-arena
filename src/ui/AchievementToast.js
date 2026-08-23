// Top-center "Achievement Completed" notification. Slides in, pauses, fades out.
// Multiple completions queue and play one at a time. push(def) where def is an
// achievement definition (name/desc/reward).

import { el, hexToCss } from "./dom.js";
import { GAME } from "../config.js";

const HOLD_MS = 2600; // visible duration before sliding out
const GAP_MS = 350; // gap between queued toasts

export class AchievementToast {
  constructor() {
    this.queue = [];
    this.active = false;

    this.name = el("div", { class: "ia-toast-name" });
    this.desc = el("div", { class: "ia-toast-desc" });
    this.reward = el("div", { class: "ia-toast-reward" });
    this.root = el("div", { class: "ia-toast" }, [
      el("div", { class: "ia-toast-head", text: "🏆 ACHIEVEMENT COMPLETE" }),
      this.name,
      this.desc,
      this.reward,
    ]);
    document.body.appendChild(this.root);
  }

  push(def) {
    this.queue.push(def);
    if (!this.active) this.#next();
  }

  #next() {
    const def = this.queue.shift();
    if (!def) {
      this.active = false;
      return;
    }
    this.active = true;

    this.name.textContent = def.name;
    this.desc.textContent = def.desc;
    this.reward.replaceChildren(
      el("span", { class: "ia-k", text: "Reward" }),
      el("div", { class: "ia-reward-cards" }, this.#rewardCards(def.reward)),
    );

    requestAnimationFrame(() => this.root.classList.add("ia-show"));
    setTimeout(() => {
      this.root.classList.remove("ia-show");
      setTimeout(() => this.#next(), GAP_MS);
    }, HOLD_MS);
  }

  #rewardCards(reward) {
    const out = [];
    if (reward.money) out.push(this.#card(`$${reward.money}`, "Money", "#ffd24a"));
    if (reward.title != null) {
      const t = GAME.titles[reward.title];
      out.push(this.#card(`[${t.name}]`, "Title", hexToCss(t.color)));
    }
    return out;
  }

  #card(name, type, color) {
    const value = el("div", { class: "ia-rc-value", text: name });
    if (color) value.style.color = color;
    return el("div", { class: "ia-reward-card" }, [value, el("div", { class: "ia-rc-type", text: type })]);
  }
}
