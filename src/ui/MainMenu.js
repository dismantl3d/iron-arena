// Main menu overlay: title, editable username, the entry buttons, a money
// readout (top-right), and an Achievements button (left-middle) with an unseen
// badge. Pure UI — it reports intent through callbacks; GameFlow wires them.

import { el } from "./dom.js";
import { unseenAchievementCount } from "../game/Progression.js";

export class MainMenu {
  // callbacks: { onPlay(), onIronPath(), onCosmetics(), onArsenal(), onShop(), onAchievements() }
  constructor(profile, callbacks) {
    this.profile = profile;
    this.cb = callbacks;

    this.input = el("input", {
      class: "ia-input",
      attrs: { type: "text", maxlength: "18", placeholder: "Unnamed Tank", value: profile.username },
      on: {
        input: () => {
          this.profile.username = this.input.value;
        },
      },
    });

    const col = el("div", { class: "ia-col ia-menu-card" }, [
      el("h1", { class: "ia-title", text: "IRON ARENA" }),
      this.input,
      el("button", { class: "ia-btn ia-primary", text: "PLAY", on: { click: () => this.cb.onPlay() } }),
      el("button", { class: "ia-btn", text: "IRON PATH", on: { click: () => this.cb.onIronPath() } }),
      el("button", { class: "ia-btn", text: "COSMETICS", on: { click: () => this.cb.onCosmetics() } }),
      el("button", { class: "ia-btn", text: "ARSENAL", on: { click: () => this.cb.onArsenal() } }),
      el("button", { class: "ia-btn", text: "SHOP", on: { click: () => this.cb.onShop() } }),
    ]);

    // Money + account readout, top-right. The account chip shows the player LEVEL
    // and whether progression is backed by an online account or local-only (offline).
    this.money = el("div", { class: "ia-money" });
    this.level = el("div", { class: "ia-acct-level" });
    this.acctStatus = el("div", { class: "ia-acct-status" });
    this.acct = el("div", { class: "ia-account" }, [this.level, this.acctStatus]);

    // Left-middle side stack: Achievements (with an unseen badge) + a developer
    // TEST button below it.
    this.badge = el("span", { class: "ia-badge ia-hidden" });
    this.achBtn = el(
      "button",
      { class: "ia-side-btn", on: { click: () => this.cb.onAchievements() } },
      [el("span", { text: "🏆" }), el("span", { class: "ia-side-label", text: "Achievements" }), this.badge],
    );
    this.testBtn = el(
      "button",
      { class: "ia-side-btn ia-test-btn", on: { click: () => this.cb.onTest() } },
      [el("span", { text: "🛠" }), el("span", { class: "ia-side-label", text: "TEST" })],
    );
    const side = el("div", { class: "ia-side-stack" }, [this.achBtn, this.testBtn]);

    this.root = el("div", { class: "ia-overlay ia-modal ia-menu ia-hidden" }, [this.money, this.acct, side, col]);
    document.body.appendChild(this.root);
  }

  show() {
    this.input.value = this.profile.username;
    this.refresh();
    this.root.classList.remove("ia-hidden");
  }

  // Refresh money + level + account status + achievement badge (call after returning
  // from a match/panel, or when the online account profile syncs).
  refresh() {
    this.money.textContent = `$${this.profile.money}`;
    this.level.textContent = `LVL ${this.profile.ironPathLevel}`;
    this.acctStatus.textContent = this.profile.online ? "● Account synced" : "Local progress";
    this.acctStatus.classList.toggle("ia-acct-online", !!this.profile.online);
    const n = unseenAchievementCount(this.profile);
    this.badge.textContent = `(${n})`;
    this.badge.classList.toggle("ia-hidden", n === 0);
  }

  hide() {
    this.root.classList.add("ia-hidden");
  }
}
