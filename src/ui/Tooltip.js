// A single shared custom tooltip (DOM) — flat, animated, no browser title.
// Used by the Cosmetics titles and the Iron Path track. Call show(anchorEl,
// lines) on hover and hide() on leave. `lines` is [{ text, type? }] where the
// first line is the name and the second (optional) is the type/desc.

import { el } from "./dom.js";

// Compact custom "spark" glyph (NOT the ✨ unicode char) for the FX indicator —
// a big 4-point star + a small one, sitting close together, in Iron Arena gold.
const FX_ICON =
  `<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">` +
  `<path d="M6 1 L6.9 5.1 L11 6 L6.9 6.9 L6 11 L5.1 6.9 L1 6 L5.1 5.1 Z" fill="#ffd24a"/>` +
  `<path d="M10 1.6 L10.35 2.65 L11.4 3 L10.35 3.35 L10 4.4 L9.65 3.35 L8.6 3 L9.65 2.65 Z" fill="#ffe38a"/></svg>`;

export class Tooltip {
  constructor() {
    this.name = el("div", { class: "ia-tip-name" });
    this.sub = el("div", { class: "ia-tip-sub" });
    this.fx = el("div", { class: "ia-tip-fx" });
    this.fx.innerHTML = `${FX_ICON}<span>FX</span>`;
    this.root = el("div", { class: "ia-tip" }, [this.name, this.sub, this.fx]);
    document.body.appendChild(this.root);
  }

  // anchor: element to point at. info: { name, type, fx? }. When `fx` is true, a
  // spark "FX" badge is shown at the BOTTOM (only for items flagged FX).
  show(anchor, info) {
    this.name.textContent = info.name || "";
    this.sub.textContent = info.type || "";
    this.sub.style.display = info.type ? "block" : "none";
    this.fx.style.display = info.fx ? "flex" : "none";
    const r = anchor.getBoundingClientRect();
    this.root.style.left = `${r.left + r.width / 2}px`;
    this.root.style.top = `${r.top - 10}px`;
    requestAnimationFrame(() => this.root.classList.add("ia-show"));
  }

  hide() {
    this.root.classList.remove("ia-show");
  }
}

// One lazily-created instance shared across the UI.
let shared = null;
export function sharedTooltip() {
  if (!shared) shared = new Tooltip();
  return shared;
}
