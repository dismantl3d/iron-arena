// Victory screen shown when the player is the last tank standing. Displays the
// winner line ("[TITLE] Username") and the run stats, then the same results
// flow (Main Menu / Play Again) as the death screen.

import { el } from "./dom.js";

export class WinnerScreen {
  // callbacks: { onMenu(), onPlayAgain() }
  constructor(callbacks) {
    this.cb = callbacks;

    this.winner = el("div", { class: "ia-winner-name" });
    this.kills = el("span", { class: "ia-v" });
    this.survival = el("span", { class: "ia-v" });

    const stats = el("div", { class: "ia-stats" }, [
      el("span", { class: "ia-k", text: "Kills" }), this.kills,
      el("span", { class: "ia-k", text: "Survival Time" }), this.survival,
    ]);

    const buttons = el("div", { class: "ia-col" }, [
      el("button", { class: "ia-btn ia-primary", text: "PLAY AGAIN", on: { click: () => this.cb.onPlayAgain() } }),
      el("button", { class: "ia-btn", text: "MAIN MENU", on: { click: () => this.cb.onMenu() } }),
    ]);

    const col = el("div", { class: "ia-col" }, [
      el("h1", { class: "ia-victory-title", text: "VICTORY" }),
      el("div", { class: "ia-sub", text: "WINNER" }),
      this.winner,
      stats,
      buttons,
    ]);

    this.root = el("div", { class: "ia-overlay ia-modal ia-hidden" }, [col]);
    document.body.appendChild(this.root);
  }

  show(stats) {
    this.winner.textContent = `[${stats.title}] ${stats.name}`;
    this.kills.textContent = String(stats.kills);
    this.survival.textContent = `${stats.survival.toFixed(1)}s`;
    this.root.classList.remove("ia-hidden");
  }

  hide() {
    this.root.classList.add("ia-hidden");
  }
}
