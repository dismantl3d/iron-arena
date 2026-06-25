// Cosmetics Locker (redesigned). A live tank SHOWCASE sits at the top (color +
// wrap + weapon + title, updates instantly), with tabbed controls below that
// slide horizontally — one category visible at a time:
//
//   [ Colors ] [ Wraps ] [ Trails ] [ Kill FX ] [ Titles ]
//
// Reports each choice through callbacks; GameFlow applies them live + persists.
// Everything is selectable for now (unlock gating comes later).

import { el, hexToCss } from "./dom.js";
import { GAME } from "../config.js";
import { weaponPreviewSvg } from "./weaponPreview.js";
import { sharedTooltip } from "./Tooltip.js";

const TABS = [
  { key: "colors", label: "Colors" },
  { key: "wraps", label: "Wraps" },
  { key: "trails", label: "Trails" },
  { key: "killFx", label: "Kill FX" },
  { key: "titles", label: "Titles" },
];

export class CosmeticsPanel {
  // cb: { onColor(i), onWrap(i), onTrail(i), onKillFx(i), onTitle(i) }, onClose()
  constructor(profile, cb, onClose) {
    this.profile = profile;
    this.cb = cb;
    this.tab = 0;
    this.tip = sharedTooltip();

    // Live showcase.
    this.art = el("div", { class: "ia-cos-art" });
    this.titleText = el("div", { class: "ia-cos-title" });
    const showcase = el("div", { class: "ia-cos-preview" }, [this.art, this.titleText]);

    // Tab bar.
    this.tabBtns = TABS.map((t, i) =>
      el("button", { class: "ia-cos-tab", text: t.label, on: { click: () => this.#setTab(i) } }),
    );
    const tabBar = el("div", { class: "ia-cos-tabs" }, this.tabBtns);

    // Sliding pages.
    this.pages = TABS.map(() => el("div", { class: "ia-cos-page" }));
    this.track = el("div", { class: "ia-cos-track" }, this.pages);
    const viewport = el("div", { class: "ia-cos-viewport" }, [this.track]);

    this.card = el("div", { class: "ia-panel ia-cos-panel" }, [
      el("h2", { text: "COSMETICS" }),
      showcase,
      tabBar,
      viewport,
      el("button", { class: "ia-btn", text: "Back", on: { click: () => onClose() } }),
    ]);
    this.root = el("div", { class: "ia-overlay ia-scrim ia-hidden" }, [this.card]);
    document.body.appendChild(this.root);
  }

  show() {
    this.#render();
    this.#setTab(this.tab);
    this.root.classList.remove("ia-hidden");
  }
  hide() {
    this.tip.hide();
    this.root.classList.add("ia-hidden");
  }

  #setTab(i) {
    this.tab = i;
    this.track.style.transform = `translateX(${-i * 100}%)`;
    this.tabBtns.forEach((b, k) => b.classList.toggle("ia-active", k === i));
  }

  #color() {
    return (GAME.cosmetics[this.profile.cosmetic] || GAME.cosmetics[0]).color;
  }
  #wrapPattern() {
    return (GAME.wraps[this.profile.wrap] || GAME.wraps[0]).pattern;
  }

  // Rebuild everything from the current profile (keeps selection state correct).
  #render() {
    this.#renderShowcase();
    this.#renderColors();
    this.#renderWraps();
    this.#renderTrails();
    this.#renderKillFx();
    this.#renderTitles();
  }

  #renderShowcase() {
    const weapon = GAME.weapons[this.profile.weapon] || GAME.weapons[0];
    this.art.innerHTML = weaponPreviewSvg(weapon, { color: this.#color(), wrap: this.#wrapPattern() });
    this.titleText.textContent = `[${(GAME.titles[this.profile.title] || GAME.titles[0]).name}]`;
  }

  #renderColors() {
    const p = this.pages[0];
    p.replaceChildren();
    const row = el("div", { class: "ia-cos-swatches" });
    GAME.cosmetics.forEach((c, i) => {
      const sw = el("div", {
        class: "ia-swatch-circle" + (i === this.profile.cosmetic ? " ia-selected" : ""),
        style: { background: hexToCss(c.color) },
        on: {
          click: () => {
            this.cb.onColor(i);
            this.#renderShowcase();
            this.#renderColors();
          },
        },
      });
      row.appendChild(sw);
    });
    p.appendChild(row);
  }

  #renderWraps() {
    const p = this.pages[1];
    p.replaceChildren();
    const grid = el("div", { class: "ia-cos-grid" });
    GAME.wraps.forEach((w, i) => {
      const art = el("div", { class: "ia-cos-cardart" });
      art.innerHTML = weaponPreviewSvg({ turret: "single" }, { color: this.#color(), wrap: w.pattern });
      const card = el(
        "div",
        {
          class: "ia-cos-card" + (i === this.profile.wrap ? " ia-selected" : ""),
          on: {
            click: () => {
              this.cb.onWrap(i);
              this.#renderShowcase();
              this.#renderWraps();
            },
          },
        },
        [art, el("div", { class: "ia-cos-cardname", text: w.name })],
      );
      grid.appendChild(card);
    });
    p.appendChild(grid);
  }

  #renderTrails() {
    const p = this.pages[2];
    p.replaceChildren();
    const grid = el("div", { class: "ia-cos-grid" });
    GAME.trails.forEach((t, i) => {
      const fx = el("div", { class: `ia-trail-demo ia-trail-${t.style}` });
      if (t.color) fx.style.setProperty("--c", hexToCss(t.color));
      const card = el(
        "div",
        {
          class: "ia-cos-card" + (i === this.profile.trail ? " ia-selected" : ""),
          on: {
            click: () => {
              this.cb.onTrail(i);
              this.#renderTrails();
            },
          },
        },
        [el("div", { class: "ia-cos-cardart" }, [fx]), el("div", { class: "ia-cos-cardname", text: t.name })],
      );
      grid.appendChild(card);
    });
    p.appendChild(grid);
  }

  #renderKillFx() {
    const p = this.pages[3];
    p.replaceChildren();
    const grid = el("div", { class: "ia-cos-grid" });
    GAME.killFx.forEach((k, i) => {
      const fx = el("div", { class: `ia-killfx-demo ia-killfx-${k.fx}` });
      const card = el(
        "div",
        {
          class: "ia-cos-card" + (i === this.profile.killFx ? " ia-selected" : ""),
          on: {
            click: () => {
              this.cb.onKillFx(i);
              this.#renderKillFx();
            },
          },
        },
        [el("div", { class: "ia-cos-cardart" }, [fx]), el("div", { class: "ia-cos-cardname", text: k.name })],
      );
      grid.appendChild(card);
    });
    p.appendChild(grid);
  }

  #renderTitles() {
    const p = this.pages[4];
    p.replaceChildren();
    const list = el("div", { class: "ia-cos-titles" });
    GAME.titles.forEach((t, i) => {
      const chip = el("div", {
        class: "ia-title-chip" + (i === this.profile.title ? " ia-selected" : ""),
        text: `[${t.name}]`,
        on: {
          click: () => {
            this.cb.onTitle(i);
            this.#renderShowcase();
            this.#renderTitles();
          },
          mouseenter: () => this.tip.show(chip, { name: t.name, type: t.desc }),
          mouseleave: () => this.tip.hide(),
        },
      });
      list.appendChild(chip);
    });
    p.appendChild(list);
  }
}
