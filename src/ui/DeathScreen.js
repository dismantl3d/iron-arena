// Death screen overlay: shows the run's stats and offers Main Menu / Play Again.
// When the killer is a tank entity (a bot, or a human in multiplayer), a "KILLED
// BY" card shows their actual tank (color/wrap/weapon) + name + title.

import { el, hexToCss } from "./dom.js";
import { weaponPreviewSvg } from "./weaponPreview.js";

export class DeathScreen {
  // callbacks: { onMenu(), onPlayAgain() }
  constructor(callbacks) {
    this.cb = callbacks;

    // "KILLED BY" card (hidden unless the killer is a drawable tank).
    this.killerArt = el("div", { class: "ia-killedby-art" });
    this.killerName = el("div", { class: "ia-killedby-name" });
    this.killerTitle = el("div", { class: "ia-killedby-title" });
    this.killerCard = el("div", { class: "ia-killedby ia-hidden" }, [
      el("div", { class: "ia-killedby-label", text: "KILLED BY" }),
      this.killerArt,
      this.killerName,
      this.killerTitle,
    ]);

    this.killedBy = el("span", { class: "ia-v" });
    this.survival = el("span", { class: "ia-v" });
    this.kills = el("span", { class: "ia-v" });
    this.xp = el("span", { class: "ia-v" });

    const stats = el("div", { class: "ia-stats" }, [
      el("span", { class: "ia-k", text: "Killed By" }), this.killedBy,
      el("span", { class: "ia-k", text: "Survival Time" }), this.survival,
      el("span", { class: "ia-k", text: "Kills" }), this.kills,
      el("span", { class: "ia-k", text: "Iron Path XP" }), this.xp,
    ]);

    const buttons = el("div", { class: "ia-col" }, [
      el("button", { class: "ia-btn ia-primary", text: "PLAY AGAIN", on: { click: () => this.cb.onPlayAgain() } }),
      el("button", { class: "ia-btn", text: "MAIN MENU", on: { click: () => this.cb.onMenu() } }),
    ]);

    const col = el("div", { class: "ia-col" }, [
      el("h1", { class: "ia-death-title", text: "YOU DIED" }),
      this.killerCard,
      stats,
      buttons,
    ]);

    this.root = el("div", { class: "ia-overlay ia-modal ia-hidden" }, [col]);
    document.body.appendChild(this.root);
  }

  show(stats) {
    this.killedBy.textContent = stats.killedBy;
    this.survival.textContent = `${stats.survival.toFixed(1)}s`;
    this.kills.textContent = String(stats.kills);
    this.xp.textContent = `+${stats.xp ?? 0}`;
    this.#renderKiller(stats.killer);
    this.root.classList.remove("ia-hidden");
  }

  // Draw the killer's actual tank + name + title. Hidden for fog/guardian deaths
  // (no drawable entity). No title -> the title line is simply omitted (no "[]").
  #renderKiller(killer) {
    if (!killer || !killer.tank) {
      this.killerCard.classList.add("ia-hidden");
      return;
    }
    const t = killer.tank;
    this.killerArt.innerHTML = weaponPreviewSvg(
      { turret: t.turret || "single" },
      { color: t.color, gradient: t.gradient || null, wrap: t.wrap || "none" },
    );
    this.killerName.textContent = killer.name || "";
    const title = killer.title;
    if (title && title.name) {
      this.killerTitle.textContent = `[${title.name}]`;
      this.killerTitle.style.color = hexToCss(title.color ?? 0x9aa0b0);
      this.killerTitle.style.fontWeight = title.bold ? "800" : "700";
      this.killerTitle.classList.remove("ia-hidden");
    } else {
      this.killerTitle.classList.add("ia-hidden"); // No Title -> omit entirely
    }
    this.killerCard.classList.remove("ia-hidden");
  }

  hide() {
    this.root.classList.add("ia-hidden");
  }
}
