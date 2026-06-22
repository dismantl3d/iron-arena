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
import { CosmeticsPanel, WeaponPanel, IronPathPanel } from "../ui/LockerPanels.js";

export class GameFlow {
  constructor(engine, input) {
    this.engine = engine;
    this.input = input;
    this.profile = Profile.load();

    this.game = new Game(engine, input, {
      onCountdown: (s) => this.waiting.setCountdown(s),
      onMatchStart: () => this.#onMatchStart(),
      onMatchEnd: (stats) => this.#onMatchEnd(stats),
      onWin: (stats) => this.winnerScreen.show(stats),
    });

    // Customization panels (shared by the menu and the waiting room).
    this.cosmetics = new CosmeticsPanel(this.profile, (i) => this.#selectCosmetic(i), () => this.#closePanels());
    this.weapon = new WeaponPanel(this.profile, (i) => this.#selectWeapon(i), () => this.#closePanels());
    this.ironPath = new IronPathPanel(this.profile, () => this.#closePanels());

    this.menu = new MainMenu(this.profile, {
      onPlay: () => this.#play(),
      onIronPath: () => this.#openPanel(this.ironPath),
      onCosmetics: () => this.#openPanel(this.cosmetics),
      onWeapon: () => this.#openPanel(this.weapon),
    });
    this.waiting = new WaitingRoom({
      onCosmetics: () => this.#openPanel(this.cosmetics),
      onWeapon: () => this.#openPanel(this.weapon),
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
    this.game.showMenuBackground();
    this.menu.show();
  }

  #play() {
    this.profile.save();
    this.menu.hide();
    this.death.hide();
    this.winnerScreen.hide();
    this.#closePanels();
    this.game.enterWaiting(this.profile);
    this.waiting.show();
  }

  #onMatchStart() {
    this.waiting.hide();
    this.#closePanels(); // cosmetics/weapon are now locked
  }

  #onMatchEnd(stats) {
    // No Iron Path XP logic yet — just show the run results.
    this.death.show(stats);
  }

  // --- customization (works in menu and live in the waiting room) ----------

  #selectCosmetic(i) {
    this.profile.cosmetic = i;
    this.profile.save();
    this.game.setCosmetic(i);
  }

  #selectWeapon(i) {
    this.profile.weapon = i;
    this.profile.save();
    this.game.setWeapon(i);
  }

  #openPanel(panel) {
    this.#closePanels();
    panel.show();
  }

  #closePanels() {
    this.cosmetics.hide();
    this.weapon.hide();
    this.ironPath.hide();
  }
}
