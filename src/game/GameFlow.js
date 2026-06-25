// GameFlow is the match-flow state machine. It owns the player Profile, the
// Game, and the DOM screen overlays, and drives transitions:
//
//   MENU  --PLAY-->  WAITING  --countdown ends-->  PLAYING  --death-->  DEAD
//     ^                                                                   |
//     +----------------------- Main Menu --------------------------------+
//                              (or Play Again -> WAITING)
//
// The Game handles all in-world gameplay; GameFlow just decides which phase the
// Game is in and which overlay is visible. No networking — single player + bots.

import { Game } from "./Game.js";
import { Profile } from "./Profile.js";
import { MainMenu } from "../ui/MainMenu.js";
import { WaitingRoom } from "../ui/WaitingRoom.js";
import { DeathScreen } from "../ui/DeathScreen.js";
import { WinnerScreen } from "../ui/WinnerScreen.js";
import { ArsenalPanel, IronPathPanel } from "../ui/LockerPanels.js";
import { CosmeticsPanel } from "../ui/CosmeticsPanel.js";

export class GameFlow {
  constructor(engine, input) {
    this.engine = engine;
    this.input = input;
    this.profile = Profile.load();

    // Which base screen is showing ("menu" | "waiting" | other). Panels float
    // above it; only one base screen + at most one panel is ever visible.
    this._screen = "menu";

    this.game = new Game(engine, input, {
      onCountdown: (s) => this.waiting.setCountdown(s),
      onMatchStart: () => this.#onMatchStart(),
      onMatchEnd: (stats) => this.#onMatchEnd(stats),
      onWin: (stats) => this.winnerScreen.show(stats),
    });

    // Customization panels (shared by the menu and the waiting room). Their Back
    // button returns to whatever base screen opened them.
    this.cosmetics = new CosmeticsPanel(
      this.profile,
      {
        onColor: (i) => this.#select("cosmetic", "setCosmetic", i),
        onWrap: (i) => this.#select("wrap", "setWrap", i),
        onTrail: (i) => this.#select("trail", "setTrail", i),
        onKillFx: (i) => this.#select("killFx", "setKillFx", i),
        onTitle: (i) => this.#select("title", "setTitle", i),
      },
      () => this.#backFromPanel(),
    );
    this.arsenal = new ArsenalPanel(this.profile, (i) => this.#select("weapon", "setWeapon", i), () => this.#backFromPanel());
    this.ironPath = new IronPathPanel(this.profile, () => this.#backFromPanel());

    this.menu = new MainMenu(this.profile, {
      onPlay: () => this.#play(),
      onIronPath: () => this.#openPanel(this.ironPath),
      onCosmetics: () => this.#openPanel(this.cosmetics),
      onArsenal: () => this.#openPanel(this.arsenal),
    });
    this.waiting = new WaitingRoom({
      onCosmetics: () => this.#openPanel(this.cosmetics),
      onArsenal: () => this.#openPanel(this.arsenal),
    });
    this.death = new DeathScreen({
      onMenu: () => this.#toMenu(),
      onPlayAgain: () => this.#play(),
    });
    this.winnerScreen = new WinnerScreen({
      onMenu: () => this.#toMenu(),
      onPlayAgain: () => this.#play(),
    });

    this.#toMenu();
  }

  #toMenu() {
    this.#closePanels();
    this.waiting.hide();
    this.death.hide();
    this.winnerScreen.hide();
    this._screen = "menu";
    this.game.showMenuBackground();
    this.menu.show();
  }

  #play() {
    this.profile.save();
    this.menu.hide();
    this.death.hide();
    this.winnerScreen.hide();
    this.#closePanels();
    this._screen = "waiting";
    this.game.enterWaiting(this.profile);
    this.waiting.show();
  }

  #onMatchStart() {
    this.waiting.hide();
    this.#closePanels(); // cosmetics/arsenal are now locked
    this._screen = "playing";
  }

  #onMatchEnd(stats) {
    this._screen = "dead";
    this.death.show(stats);
  }

  // --- customization (works in menu and live in the waiting room) ----------

  // Persist the chosen index on the profile and apply it live on the Game.
  #select(field, method, i) {
    this.profile[field] = i;
    this.profile.save();
    this.game[method](i);
  }

  // Open a panel as the single active screen. From the main menu we hide the
  // menu entirely (fixes panels opening behind it); in the waiting room the
  // banner stays visible behind the panel so the live tank preview shows.
  #openPanel(panel) {
    this.#closePanels();
    if (this._screen === "menu") this.menu.hide();
    panel.show();
  }

  // Back button: close the panel and restore the base screen it came from.
  #backFromPanel() {
    this.#closePanels();
    if (this._screen === "menu") this.menu.show();
    // waiting room: its overlay was never hidden, nothing to restore.
  }

  #closePanels() {
    this.cosmetics.hide();
    this.arsenal.hide();
    this.ironPath.hide();
  }
}
