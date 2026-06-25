// A single shared custom tooltip (DOM) — flat, animated, no browser title.
// Used by the Cosmetics titles and the Iron Path track. Call show(anchorEl,
// lines) on hover and hide() on leave. `lines` is [{ text, type? }] where the
// first line is the name and the second (optional) is the type/desc.

import { el } from "./dom.js";

export class Tooltip {
  constructor() {
    this.name = el("div", { class: "ia-tip-name" });
    this.sub = el("div", { class: "ia-tip-sub" });
    this.root = el("div", { class: "ia-tip" }, [this.name, this.sub]);
    document.body.appendChild(this.root);
  }

  // anchor: element to point at. info: { name, type }.
  show(anchor, info) {
    this.name.textContent = info.name || "";
    this.sub.textContent = info.type || "";
    this.sub.style.display = info.type ? "block" : "none";
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
