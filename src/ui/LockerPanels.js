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
      const wide = reward.type === "weapon" || reward.type === "title";

      const cls =
        "ia-node" +
        (wide ? " ia-weapon" : "") +
        (unlocked ? " ia-unlocked" : "") +
        (isCurrent ? " ia-current" : "");

      const kids = [el("div", { class: "ia-node-lvl", text: `Lv ${lvl}` })];
      kids.push(...this.#preview(reward, color, unlocked));

      const tip = this.#tooltip(reward);
      const node = el(
        "div",
        { class: cls, on: { mouseenter: () => this.tip.show(node, tip), mouseleave: () => this.tip.hide() } },
        kids,
      );
      if (isCurrent) current = node;
      this.track.appendChild(node);
    }

    if (current) requestAnimationFrame(() => current.scrollIntoView({ inline: "center", block: "nearest" }));
  }

  // The visual preview elements for a reward (matches its type).
  #preview(reward, color, unlocked) {
    switch (reward.type) {
      case "weapon": {
        const w = GAME.weapons[reward.index];
        const art = el("div", { class: "ia-node-art" });
        art.innerHTML = weaponPreviewSvg(w, { color, locked: !unlocked });
        return [art, el("div", { class: "ia-node-name", text: w.name })];
      }
      case "title": {
        const t = GAME.titles[reward.index];
        return [
          el("div", { class: "ia-node-art" }, [
            el("div", { class: "ia-node-title", style: { color: hexToCss(t.color) }, text: `[${t.name}]` }),
          ]),
          el("div", { class: "ia-node-name", text: "Title" }),
        ];
      }
      case "wrap": {
        const w = GAME.wraps[reward.index];
        const art = el("div", { class: "ia-node-art" });
        art.innerHTML = weaponPreviewSvg({ turret: "single" }, { color, wrap: w.pattern });
        return [art, el("div", { class: "ia-node-name", text: w.name })];
      }
      case "trail": {
        const t = GAME.trails[reward.index];
        const line = el("div", { class: `ia-trail-demo ia-trail-${t.style}` });
        if (t.color) line.style.setProperty("--c", hexToCss(t.color));
        return [el("div", { class: "ia-node-art" }, [line]), el("div", { class: "ia-node-name", text: t.name })];
      }
      case "money":
        return [
          el("div", { class: "ia-node-art" }, [el("div", { class: "ia-node-coin", text: "$" })]),
          el("div", { class: "ia-node-name", text: `$${reward.amount}` }),
        ];
      default:
        return [el("div", { class: "ia-node-dot" })];
    }
  }

  // Hover tooltip { name, type } for a reward.
  #tooltip(reward) {
    switch (reward.type) {
      case "weapon":
        return { name: GAME.weapons[reward.index].name, type: "Weapon" };
      case "title":
        return { name: GAME.titles[reward.index].name, type: "Title" };
      case "wrap":
        return { name: GAME.wraps[reward.index].name, type: "Wrap" };
      case "trail":
        return { name: GAME.trails[reward.index].name, type: "Trail" };
      case "money":
        return { name: `$${reward.amount}`, type: "Currency" };
      default:
        return { name: "Progress Node", type: "Iron Path" };
    }
  }
}
