// Customization panels reached from the main menu and the waiting room:
//   CosmeticsPanel — pick a tank body color
//   WeaponPanel    — pick a (placeholder) weapon loadout
//   IronPathPanel  — view accumulated Iron Path XP (placeholder progression)
//
// Each is a floating card over a light scrim (so the live tank shows behind in
// the waiting room). They read the current selection from the profile and report
// choices via onSelect; GameFlow applies them live + persists.

import { el, hexToCss } from "./dom.js";
import { GAME } from "../config.js";

class Panel {
  constructor(title, onClose) {
    this.body = el("div", { class: "ia-row" });
    this.card = el("div", { class: "ia-panel" }, [
      el("h2", { text: title }),
      this.body,
      el("button", { class: "ia-btn", text: "Close", on: { click: () => onClose() } }),
    ]);
    this.root = el("div", { class: "ia-overlay ia-scrim ia-hidden" }, [this.card]);
    document.body.appendChild(this.root);
  }
  show() {
    this.root.classList.remove("ia-hidden");
  }
  hide() {
    this.root.classList.add("ia-hidden");
  }
}

export class CosmeticsPanel extends Panel {
  // onSelect(index) — called when a swatch is chosen.
  constructor(profile, onSelect, onClose) {
    super("COSMETICS", onClose);
    this.profile = profile;
    this.swatches = GAME.cosmetics.map((c, i) =>
      el("div", {
        class: "ia-swatch",
        style: { background: hexToCss(c.color) },
        attrs: { title: c.name },
        on: {
          click: () => {
            onSelect(i);
            this.#highlight();
          },
        },
      }),
    );
    this.swatches.forEach((s) => this.body.appendChild(s));
    this.#highlight();
  }
  #highlight() {
    this.swatches.forEach((s, i) =>
      s.classList.toggle("ia-selected", i === this.profile.cosmetic),
    );
  }
  show() {
    this.#highlight();
    super.show();
  }
}

export class WeaponPanel extends Panel {
  constructor(profile, onSelect, onClose) {
    super("WEAPON LOCKER", onClose);
    this.profile = profile;
    this.body.classList.add("ia-col"); // stack weapons vertically
    this.options = GAME.weapons.map((w, i) =>
      el("div", {
        class: "ia-option",
        text: w.name,
        on: {
          click: () => {
            onSelect(i);
            this.#highlight();
          },
        },
      }),
    );
    this.options.forEach((o) => this.body.appendChild(o));
    this.#highlight();
  }
  #highlight() {
    this.options.forEach((o, i) => o.classList.toggle("ia-selected", i === this.profile.weapon));
  }
  show() {
    this.#highlight();
    super.show();
  }
}

export class IronPathPanel extends Panel {
  constructor(profile, onClose) {
    super("IRON PATH", onClose);
    this.profile = profile;
    this.info = el("p", { class: "ia-note" });
    this.body.classList.add("ia-col");
    this.body.appendChild(this.info);
  }
  show() {
    const xp = this.profile.ironPathXp;
    // Placeholder progression: 1 tier per 500 XP.
    const tier = Math.floor(xp / 500) + 1;
    const into = xp % 500;
    this.info.textContent = `Total Iron Path XP: ${xp}   ·   Tier ${tier} (${into}/500)`;
    super.show();
  }
}
