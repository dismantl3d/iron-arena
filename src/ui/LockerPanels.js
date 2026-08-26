// Customization panels reached from the main menu and the waiting room:
//   ArsenalPanel   — pick a weapon (card grid; locked until unlocked on the Iron Path)
//   IronPathPanel  — the 1..60 progression track (weapon unlocks every 6 levels)
// (The redesigned Cosmetics locker lives in CosmeticsPanel.js.)
//
// Each is a floating card above everything (the menu hides itself when one opens
// — see GameFlow). They read the current selection/level from the profile and
// report choices via onSelect; GameFlow applies them live + persists.

import { el, hexToCss } from "./dom.js";
import { GAME } from "../config.js";
import { weaponPreviewSvg } from "./weaponPreview.js";
import { sharedTooltip } from "./Tooltip.js";
import { isWeaponUnlocked, unlockLevel, levelProgress } from "../game/IronPath.js";

// A cosmetic color's FX gradient tuple [c1, c2, dir], or null.
const gradOf = (c) => (c && c.gradient ? [c.gradient[0], c.gradient[1], c.dir] : null);

// { name, type, fx } for any Iron Path reward — the single source of truth for the
// display name, its human-readable TYPE, and whether it carries the FX indicator.
export function rewardMeta(reward) {
  switch (reward.type) {
    case "weapon": return { name: GAME.weapons[reward.index].name, type: "Weapon" };
    case "title": { const t = GAME.titles[reward.index]; return { name: t.name, type: "Title", fx: !!t.fx }; }
    case "wrap": { const w = GAME.wraps[reward.index]; return { name: w.name, type: "Tank Wrap", fx: !!w.fx }; }
    case "trail": { const t = GAME.trails[reward.index]; return { name: t.name, type: "Trail", fx: !!t.fx }; }
    case "color": { const c = GAME.cosmetics[reward.index]; return { name: c.name, type: "Tank Color", fx: !!c.fx }; }
    case "killfx": return { name: GAME.killFx[reward.index].name, type: "Kill FX" };
    case "money": return { name: `$${reward.amount}`, type: "Currency" };
    case "bundle": return { name: reward.name, type: "Bundle" };
    default: return { name: "Progress Node", type: "Iron Path" };
  }
}

// The visual preview element for a reward (art box contents), rendered in `color`.
export function rewardArt(reward, color, locked = false) {
  const art = el("div", { class: "ia-node-art" });
  switch (reward.type) {
    case "weapon":
      art.innerHTML = weaponPreviewSvg(GAME.weapons[reward.index], { color, locked });
      break;
    case "title": {
      const t = GAME.titles[reward.index];
      art.appendChild(el("div", { class: "ia-node-title" + (t.fx ? " ia-fx" : ""), style: { color: hexToCss(t.color), fontWeight: t.bold ? "800" : "700" }, text: t.none ? "No Title" : `[${t.name}]` }));
      break;
    }
    case "wrap":
      art.innerHTML = weaponPreviewSvg({ turret: "single" }, { color, wrap: GAME.wraps[reward.index].pattern });
      break;
    case "color": {
      const c = GAME.cosmetics[reward.index];
      art.innerHTML = weaponPreviewSvg({ turret: "single" }, { color: c.color, gradient: gradOf(c) });
      break;
    }
    case "trail": {
      const t = GAME.trails[reward.index];
      const line = el("div", { class: `ia-trail-demo ia-trail-${t.style}` });
      if (t.color) line.style.setProperty("--c", hexToCss(t.color));
      art.appendChild(line);
      break;
    }
    case "killfx":
      art.appendChild(el("div", { class: `ia-killfx-demo ia-killfx-${GAME.killFx[reward.index].fx}` }));
      break;
    case "money":
      art.appendChild(el("div", { class: "ia-node-coin", text: "$" }));
      break;
    case "bundle":
      art.appendChild(el("div", { class: "ia-node-bundle", text: "★" }));
      break;
    default:
      art.appendChild(el("div", { class: "ia-node-dot" }));
  }
  return art;
}

class Panel {
  constructor(title, onClose) {
    this.body = el("div", { class: "ia-row" });
    this.card = el("div", { class: "ia-panel" }, [
      el("h2", { text: title }),
      this.body,
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

// Arsenal: a 2-column scrollable grid of weapon CARDS. Each card shows the
// weapon mounted on a tank (visual turret identity). Locked weapons show a lock
// icon + faded silhouette and aren't selectable; unlocked ones are equippable.
export class ArsenalPanel extends Panel {
  constructor(profile, onSelect, onClose) {
    super("ARSENAL", onClose);
    this.profile = profile;
    this.onSelect = onSelect;
    this.body.classList.remove("ia-row");
    this.grid = el("div", { class: "ia-arsenal-grid" });
    this.body.appendChild(this.grid);
  }

  show() {
    this.#render();
    super.show();
  }

  #render() {
    const level = this.profile.ironPathLevel;
    const color = (GAME.cosmetics[this.profile.cosmetic] || GAME.cosmetics[0]).color;
    this.grid.replaceChildren();

    GAME.weapons.forEach((w, i) => {
      const locked = !isWeaponUnlocked(level, i);
      const selected = i === this.profile.weapon && !locked;

      const art = el("div", { class: "ia-card-art" });
      art.innerHTML = weaponPreviewSvg(w, { color, locked });

      const children = [
        art,
        el("div", { class: "ia-card-name", text: w.name }),
        el("div", {
          class: "ia-card-sub",
          text: locked ? `Unlocks at Lv ${unlockLevel(i)}` : "Tap to equip",
        }),
      ];
      if (locked) children.push(el("div", { class: "ia-card-lock", text: "🔒" }));

      const card = el(
        "div",
        {
          class:
            "ia-card" + (selected ? " ia-selected" : "") + (locked ? " ia-locked" : ""),
          on: {
            click: () => {
              if (locked) return;
              this.onSelect(i);
              this.#render();
            },
          },
        },
        children,
      );
      this.grid.appendChild(card);
    });
  }
}

// Iron Path: a horizontal progression track, 1..maxLevel. Early levels grant
// concrete rewards (GAME.ironPath.rewards); every `unlockEvery` levels grants a
// weapon; the rest are plain progress nodes. Each node previews its reward and
// shows a hover tooltip (name + type).
export class IronPathPanel extends Panel {
  constructor(profile, onClose) {
    super("IRON PATH", onClose);
    this.profile = profile;
    this.tip = sharedTooltip();
    this.bundle = new BundlePanel(profile); // opened when the L60 node is clicked
    this.body.classList.remove("ia-row");
    this.body.style.flexDirection = "column";

    this.head = el("div", { class: "ia-ironpath-head" }, [
      el("div", { class: "ia-ironpath-level" }),
      el("div", { class: "ia-note" }),
    ]);
    this.track = el("div", { class: "ia-track" });
    // Vertical mouse-wheel scrolls the horizontal track (scrollbars are hidden).
    this.track.addEventListener(
      "wheel",
      (e) => {
        if (!e.deltaY) return;
        e.preventDefault();
        this.track.scrollLeft += e.deltaY;
      },
      { passive: false },
    );
    this.body.append(this.head, this.track);
  }

  show() {
    this.#render();
    super.show();
  }

  // The concrete reward for a level: explicit schedule first, then a weapon at
  // each `unlockEvery` multiple, otherwise a plain progress node.
  #rewardFor(lvl) {
    const r = GAME.ironPath.rewards?.[lvl];
    if (r) return r;
    if (lvl % GAME.ironPath.unlockEvery === 0) {
      const wi = lvl / GAME.ironPath.unlockEvery;
      if (GAME.weapons[wi]) return { type: "weapon", index: wi };
    }
    return { type: "progress" };
  }

  #render() {
    const xp = this.profile.ironPathXp;
    const level = this.profile.ironPathLevel;
    const { into, need } = levelProgress(xp);
    const color = (GAME.cosmetics[this.profile.cosmetic] || GAME.cosmetics[0]).color;

    this.head.children[0].textContent = `Level ${level} / ${GAME.ironPath.maxLevel}`;
    this.head.children[1].textContent = `${xp} XP   ·   ${into}/${need} to next level`;

    this.track.replaceChildren();
    let current = null;
    for (let lvl = 1; lvl <= GAME.ironPath.maxLevel; lvl++) {
      const reward = this.#rewardFor(lvl);
      const unlocked = level >= lvl;
      const isCurrent = lvl === level;
      const wide = reward.type === "weapon" || reward.type === "title" || reward.type === "bundle";
      const meta = rewardMeta(reward);

      const cls =
        "ia-node" +
        (wide ? " ia-weapon" : "") +
        (reward.type === "bundle" ? " ia-bundle" : "") +
        (unlocked ? " ia-unlocked" : "") +
        (isCurrent ? " ia-current" : "");

      const label = reward.type === "progress" ? "" : reward.type === "bundle" ? "Bundle" : meta.name;
      const kids = [
        el("div", { class: "ia-node-lvl", text: `Lv ${lvl}` }),
        rewardArt(reward, color, !unlocked),
        el("div", { class: "ia-node-name", text: label }),
      ];

      const node = el(
        "div",
        {
          class: cls,
          on: {
            mouseenter: () => this.tip.show(node, meta),
            mouseleave: () => this.tip.hide(),
            click: reward.type === "bundle" ? () => { this.tip.hide(); this.bundle.open(); } : undefined,
          },
        },
        kids,
      );
      if (isCurrent) current = node;
      this.track.appendChild(node);
    }

    if (current) requestAnimationFrame(() => current.scrollIntoView({ inline: "center", block: "nearest" }));
  }
}

// A preview of the Level 60 Iron General Bundle's SEVEN contents. Opens OVER the
// Iron Path (keeping its context): a large preview of the selected item, left/right
// arrows to cycle, and the item name + type below. Purely a preview — the rewards
// themselves are granted by reaching level 60 like any other Iron Path reward.
export class BundlePanel {
  constructor(profile) {
    this.profile = profile;
    this.i = 0;
    this.items = GAME.ironPath.rewards[GAME.ironPath.maxLevel]?.items || [];
    this.tip = sharedTooltip();

    this.preview = el("div", { class: "ia-bundle-preview" });
    this.nameEl = el("div", { class: "ia-bundle-name" });
    this.typeEl = el("div", { class: "ia-bundle-type" });
    const left = el("button", { class: "ia-bundle-arrow", text: "‹", on: { click: () => this.#step(-1) } });
    const right = el("button", { class: "ia-bundle-arrow", text: "›", on: { click: () => this.#step(1) } });

    this.card = el("div", { class: "ia-panel ia-bundle-panel" }, [
      el("h2", { text: "IRON GENERAL BUNDLE" }),
      el("div", { class: "ia-note", text: "Level 60 · contains 7 rewards" }),
      el("div", { class: "ia-bundle-stage" }, [left, this.preview, right]),
      el("div", { class: "ia-bundle-caption" }, [this.nameEl, this.typeEl]),
      el("button", { class: "ia-btn", text: "Back", on: { click: () => this.close() } }),
    ]);
    this.root = el("div", { class: "ia-overlay ia-scrim ia-bundle-scrim ia-hidden" }, [this.card]);
    document.body.appendChild(this.root);
  }

  open() {
    this.i = 0;
    this.#render();
    this.root.classList.remove("ia-hidden");
  }
  close() {
    this.tip.hide();
    this.root.classList.add("ia-hidden");
  }
  #step(d) {
    if (!this.items.length) return;
    this.i = (this.i + d + this.items.length) % this.items.length;
    this.#render();
  }
  #render() {
    const reward = this.items[this.i];
    if (!reward) return;
    const color = (GAME.cosmetics[this.profile.cosmetic] || GAME.cosmetics[0]).color;
    const meta = rewardMeta(reward);
    this.preview.replaceChildren(rewardArt(reward, color, false));
    this.nameEl.textContent = meta.name;
    this.nameEl.classList.toggle("ia-fx", !!meta.fx);
    this.typeEl.textContent = meta.type;
  }
}
