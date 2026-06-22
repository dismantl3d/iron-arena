// Waiting-room overlay: a non-blocking countdown banner at the top (so the
// player can still see + move their tank underneath) plus Cosmetics / Weapon
// buttons. It does not dim the screen. Cosmetics/weapon lock when the match
// starts (handled by GameFlow hiding this overlay).

import { el } from "./dom.js";

export class WaitingRoom {
  // callbacks: { onCosmetics(), onWeapon() }
  constructor(callbacks) {
    this.cb = callbacks;

    this.count = el("div", { class: "ia-count", text: "30" });
    const banner = el("div", { class: "ia-banner" }, [
      el("div", { class: "ia-sub", text: "STARTING IN" }),
      this.count,
    ]);

    this.actions = el("div", { class: "ia-waiting-actions" }, [
      el("button", { class: "ia-btn", text: "Cosmetics", on: { click: () => this.cb.onCosmetics() } }),
      el("button", { class: "ia-btn", text: "Weapon", on: { click: () => this.cb.onWeapon() } }),
    ]);

    this.root = el("div", { class: "ia-overlay ia-waiting ia-hidden" }, [banner, this.actions]);
    document.body.appendChild(this.root);
  }

  setCountdown(seconds) {
    this.count.textContent = String(Math.ceil(seconds));
  }

  show() {
    this.root.classList.remove("ia-hidden");
  }

  hide() {
    this.root.classList.add("ia-hidden");
  }
}
