// Death screen overlay: shows the run's stats and offers Main Menu / Play Again.

import { el } from "./dom.js";

export class DeathScreen {
  // callbacks: { onMenu(), onPlayAgain() }
  constructor(callbacks) {
    this.cb = callbacks;

    this.killedBy = el("span", { class: "ia-v" });
    this.survival = el("span", { class: "ia-v" });
    this.kills = el("span", { class: "ia-v" });

    const stats = el("div", { class: "ia-stats" }, [
      el("span", { class: "ia-k", text: "Killed By" }), this.killedBy,
      el("span", { class: "ia-k", text: "Survival Time" }), this.survival,
      el("span", { class: "ia-k", text: "Kills" }), this.kills,
    ]);

    const buttons = el("div", { class: "ia-col" }, [
      el("button", { class: "ia-btn ia-primary", text: "PLAY AGAIN", on: { click: () => this.cb.onPlayAgain() } }),
      el("button", { class: "ia-btn", text: "MAIN MENU", on: { click: () => this.cb.onMenu() } }),
    ]);

    const col = el("div", { class: "ia-col" }, [
      el("h1", { class: "ia-death-title", text: "YOU DIED" }),
      stats,
      buttons,
    ]);

    this.root = el("div", { class: "ia-overlay ia-modal ia-hidden" }, [col]);
    document.body.appendChild(this.root);
  }

  show(stats) {
    this.killedBy.textContent = stats.killedBy;
    this.survival.textContent = `${stats.survival.toFixed(1)}s`;
    this.kills.textContent = String(stats.kills);
    this.root.classList.remove("ia-hidden");
  }

  hide() {
    this.root.classList.add("ia-hidden");
  }
}
