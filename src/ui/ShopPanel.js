// Shop (scaffolding only). Same flat card style as the Arsenal. Three sections
// — Weapons / Cosmetics / Bundles — each with placeholder "Coming Soon" cards.
// No purchasing yet; this just establishes the screen + layout.

import { el } from "./dom.js";

const SECTIONS = [
  { name: "Weapons", count: 3 },
  { name: "Cosmetics", count: 3 },
  { name: "Bundles", count: 2 },
];

export class ShopPanel {
  constructor(onClose) {
    const body = el("div", { class: "ia-shop-body" });
    for (const s of SECTIONS) {
      const cards = el(
        "div",
        { class: "ia-shop-grid" },
        Array.from({ length: s.count }, () =>
          el("div", { class: "ia-shop-card" }, [
            el("div", { class: "ia-shop-cardart" }),
            el("div", { class: "ia-shop-soon", text: "Coming Soon" }),
          ]),
        ),
      );
      body.append(el("h3", { class: "ia-shop-h", text: s.name }), cards);
    }

    this.card = el("div", { class: "ia-panel ia-shop-panel" }, [
      el("h2", { text: "SHOP" }),
      body,
      el("button", { class: "ia-btn", text: "Back", on: { click: () => onClose() } }),
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
