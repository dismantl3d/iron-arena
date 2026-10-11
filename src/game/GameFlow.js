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
import { ShopPanel } from "../ui/ShopPanel.js";
import { AchievementsPanel } from "../ui/AchievementsPanel.js";
import { AchievementToast } from "../ui/AchievementToast.js";
import { AccountPanel } from "../ui/AccountPanel.js";
import { AccountClient } from "../net/AccountClient.js";
import { MultiplayerMode } from "../net/MultiplayerMode.js";
import { GAME } from "../config.js";
import { ACHIEVEMENTS } from "./achievements.js";

export class GameFlow {
  constructor(engine, input) {
    this.engine = engine;
    this.input = input;
    this.profile = Profile.load();

    // Which base screen is showing ("menu" | "waiting" | other). Panels float
    // above it; only one base screen + at most one panel is ever visible.
    this._screen = "menu";

    this.toast = new AchievementToast();

    this.game = new Game(engine, input, {
      onCountdown: (s) => this.waiting.setCountdown(s),
      onMatchStart: () => this.#onMatchStart(),
      onMatchEnd: (stats) => this.#onMatchEnd(stats),
      onWin: (stats) => this.winnerScreen.show(stats, { hidePlayAgain: true }), // unified flow: no Play Again
      onAchievements: (def) => this.toast.push(def),
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
    this.shop = new ShopPanel(() => this.#backFromPanel());
    this.achievements = new AchievementsPanel(
      this.profile,
      () => this.#backFromPanel(),
      () => {
        this.profile.save();
        this.menu.refresh();
      },
    );

    // Online Battle Royale: the SERVER-AUTHORITATIVE match. It takes over the engine
    // while the single-player Game is paused, and reuses the SAME Waiting Room UI
    // (lobby countdown) → BR → death/winner, so online is the real Iron Arena flow
    // (server-authoritative + shared), not a separate stripped-down mode.
    this.mp = new MultiplayerMode(engine, input, this.profile, {
      onExit: () => this.#exitMultiplayer(),
      onWaiting: () => { this._screen = "mp"; this.waiting.show(); },
      onCountdown: (s) => this.waiting.setCountdown(s),
      onMatchStart: () => { this.#closePanels(); this.waiting.hide(); },
      // No server reachable → fall back to the offline Battle Royale (dev mechanism),
      // so PLAY always works even without `npm run server` running.
      onConnectFailed: () => this.#playOffline(),
      // The account synced (login / post-match reward): refresh the menu readouts
      // (level / currency) so persistent progression shows immediately.
      onProfile: () => this.menu.refresh(),
    });

    // Hosted accounts: the menu-side account client + the small login/create-account panel.
    // The server owns progression; these only collect credentials and mirror the result.
    this.accountClient = new AccountClient();
    this.accountPanel = new AccountPanel(this.profile, this.accountClient, {
      onClose: () => this.#backFromPanel(),
      onSignedIn: (wire, opts) => { this.profile.useAccount(wire, opts); this.menu.refresh(); },
      onSignedOut: () => { this.profile.useLocal(); this.menu.refresh(); },
    });

    this.menu = new MainMenu(this.profile, {
      onPlay: () => this.#play(),
      onAccount: () => this.#openPanel(this.accountPanel),
      onIronPath: () => this.#openPanel(this.ironPath),
      onCosmetics: () => this.#openPanel(this.cosmetics),
      onArsenal: () => this.#openPanel(this.arsenal),
      onShop: () => this.#openPanel(this.shop),
      onAchievements: () => this.#openPanel(this.achievements),
      onTest: () => this.#devUnlockAll(),
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
    this.#resumeAccount();
  }

  // On startup, silently re-login from a stored session so the menu shows the account's
  // progress (and a new device that logged in earlier keeps working after a reload).
  async #resumeAccount() {
    if (!this.accountClient.hasSession()) return;
    const res = await this.accountClient.resume();
    if (res.ok) this.profile.useAccount(res.profile, { adoptLoadout: true });
    else if (res.reason === "bad-session") this.profile.useLocal(); // session expired/revoked → back to local
    this.menu.refresh();
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

  // --- unified PLAY (multiplayer Battle Royale) -----------------------------
  // PLAY leads into the server-authoritative online Battle Royale: connect →
  // matchmake into a Waiting Room → 15s countdown → BR → death/winner → Main Menu.
  // If no server is reachable, it falls back to the offline BR (dev mechanism) so the
  // game still runs with `npm run dev` alone. The Waiting Room / HUD / renderer / BR
  // are the SAME components either way — only the source of truth differs.
  #play() {
    this.profile.save();
    this.#closePanels();
    this.menu.hide();
    this.death.hide();
    this.winnerScreen.hide();
    this._screen = "mp";
    this.game.paused = true; // hand the engine to the online session
    this.mp.start(); // → onWaiting shows the Waiting Room, or onConnectFailed → offline
  }

  // Offline fallback: run the local Battle Royale (identical presentation) when no
  // multiplayer server answers. Reachable only via #play's onConnectFailed.
  #playOffline() {
    this.mp.stop();
    this.profile.useLocal(); // the offline game uses the local (offline) progression
    this.menu.refresh();
    this.game.paused = false;
    this.menu.hide();
    this.death.hide();
    this.winnerScreen.hide();
    this.#closePanels();
    this._screen = "waiting";
    this.game.enterWaiting(this.profile);
    this.waiting.show();
  }

  #exitMultiplayer() {
    this.mp.stop();
    this.waiting.hide();
    this.game.paused = false;
    this.#toMenu();
  }

  #onMatchStart() {
    this.waiting.hide();
    this.#closePanels(); // cosmetics/arsenal are now locked
    this._screen = "playing";
  }

  #onMatchEnd(stats) {
    this._screen = "dead";
    this.death.show(stats, { hidePlayAgain: true }); // unified flow: no Play Again
  }

  // --- customization (works in menu and live in the waiting room) ----------

  // Persist the chosen index on the profile and apply it live on the Game.
  #select(field, method, i) {
    this.profile[field] = i;
    this.profile.save();
    this.game[method](i);
    this.#syncLoadoutSoon();
  }

  // While an account is active, persist menu loadout changes on the server (debounced). The
  // server validates against what the account owns, so this can never grant anything.
  #syncLoadoutSoon() {
    if (!this.profile.online) return;
    clearTimeout(this._loadoutTimer);
    this._loadoutTimer = setTimeout(() => this.accountClient.syncLoadout(this.profile), 700);
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
    this.shop.hide();
    this.achievements.hide();
    this.accountPanel.hide();
  }

  // Developer TEST mode: unlock everything (weapons via a maxed Iron Path,
  // cosmetics via the devUnlockAll flag), complete all achievements, and grant a
  // large amount of money. The menu updates immediately; the Cosmetics/Arsenal
  // panels re-render from the new profile state the next time they're opened.
  #devUnlockAll() {
    const p = this.profile;
    if (!p.online) {
      // Local/offline unlock (unchanged): weapons via a maxed Iron Path, cosmetics via the flag.
      p.devUnlockAll = true;
      p.ironPathXp = GAME.ironPath.maxLevel * GAME.ironPath.xpPerLevel; // complete the Iron Path
      for (const a of ACHIEVEMENTS) p.achievements[a.id] = { progress: a.goal, completed: true, seen: true };
      p.money += 100000;
      p.save();
      this.menu.refresh();
    }
    // Online progression is SERVER-owned: ask the server (it only agrees when its dev-unlock
    // switch is on — never in production). If it declines, nothing changes.
    this.accountClient.devUnlock(p.username).then((res) => {
      if (res.ok) { p.useAccount(res.profile); this.menu.refresh(); }
      else if (res.reason === "disabled") console.warn("[iron-arena] server dev-unlock is disabled (IRON_DEV_UNLOCK)");
    });
  }
}
