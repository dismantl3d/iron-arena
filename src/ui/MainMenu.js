// Main menu overlay: title, editable username, and the four entry buttons.
// Pure UI — it reports intent through the callbacks passed in; GameFlow wires
// those to the game/state machine.

import { el } from "./dom.js";

export class MainMenu {
  // callbacks: { onPlay(), onIronPath(), onCosmetics(), onWeapon() }
  constructor(profile, callbacks) {
    this.profile = profile;
    this.cb = callbacks;

    this.input = el("input", {
      class: "ia-input",
      attrs: { type: "text", maxlength: "18", placeholder: "Unnamed Tank", value: profile.username },
      on: {
        // Keep the profile in sync as the user types.
        input: () => {
          this.profile.username = this.input.value;
        },
      },
    });

    const col = el("div", { class: "ia-col" }, [
      el("h1", { class: "ia-title", text: "IRON ARENA" }),
      this.input,
      el("button", { class: "ia-btn ia-primary", text: "PLAY", on: { click: () => this.cb.onPlay() } }),
      el("button", { class: "ia-btn", text: "IRON PATH", on: { click: () => this.cb.onIronPath() } }),
      el("button", { class: "ia-btn", text: "COSMETICS", on: { click: () => this.cb.onCosmetics() } }),
      el("button", { class: "ia-btn", text: "WEAPON LOCKER", on: { click: () => this.cb.onWeapon() } }),
    ]);

    this.root = el("div", { class: "ia-overlay ia-modal ia-hidden" }, [col]);
    document.body.appendChild(this.root);
  }

  show() {
    this.input.value = this.profile.username;
    this.root.classList.remove("ia-hidden");
  }

  hide() {
    this.root.classList.add("ia-hidden");
  }
}
