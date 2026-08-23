// Screen-space HUD. Added directly to app.stage (on top of the world container)
// so it does NOT pan/zoom with the camera.
//
// Layout:
//   top-left   — score, "Alive" (battle-royale count), optional FPS
//   bottom-mid — HP bar (eased)
//
// The in-match upgrade icons live in a separate UpgradeHud (bottom-right).

import { Container, Graphics, Text } from "pixi.js";
import { COLORS } from "../config.js";

const BAR_W = 460;
const HP_H = 18;

export class Hud {
  constructor(app) {
    this.app = app;
    this.view = new Container();
    app.stage.addChild(this.view);

    // Toxic-fog warning: a red edge vignette that pulses while outside the safe
    // zone. Behind everything else so HUD text stays readable.
    this.fogWarn = new Graphics();
    this.fogWarn.alpha = 0;
    this.view.addChild(this.fogWarn);
    this._fogShown = 0;
    this._warnT = 0;

    // top-left stack
    this.score = this.#text(24, "bold", COLORS.hudText);
    this.alive = this.#text(17, "bold", COLORS.hudText);
    this.fps = this.#text(15, "normal", COLORS.hudDim);

    // bottom-center HP bar
    this.hpBg = new Graphics().roundRect(0, 0, BAR_W, HP_H, 6).fill(COLORS.hpBg);
    this.hpFill = new Graphics().roundRect(0, 0, BAR_W, HP_H, 6).fill(COLORS.hpFill);
    this.hpText = this.#text(12, "bold", COLORS.hudText);
    this.hpText.anchor.set(0.5);

    // contextual prompt (e.g. "PRESS [F] TO SWAP"), centered above the HP bar
    this.prompt = this.#text(16, "bold", COLORS.hudText);
    this.prompt.anchor.set(0.5);

    this.view.addChild(this.score, this.alive, this.fps, this.hpBg, this.hpFill, this.hpText, this.prompt);

    this._hpShown = 1; // animated bar fill

    this.layout();
  }

  #text(size, weight, fill) {
    return new Text({
      text: "",
      style: { fill, fontFamily: "Ubuntu, Arial", fontSize: size, fontWeight: weight },
    });
  }

  layout() {
    const W = this.app.screen.width;
    const H = this.app.screen.height;

    // Red edge band drawn inside the screen edges (alpha animated in update()).
    this.fogWarn.clear().rect(0, 0, W, H).stroke({ color: 0xff2e2e, width: 110, alpha: 1, alignment: 0 });

    this.score.position.set(16, 12);
    this.alive.position.set(16, 46);
    this.fps.position.set(16, 72);

    const cx = Math.round((W - BAR_W) / 2);
    const hpY = H - 34;
    this.hpBg.position.set(cx, hpY);
    this.hpFill.position.set(cx, hpY);
    this.hpText.position.set(W / 2, hpY + HP_H / 2);
    this.prompt.position.set(W / 2, hpY - 28);
  }

  // Show a contextual prompt above the HP bar, or clear it with null/"".
  setPrompt(text) {
    this.prompt.text = text || "";
  }

  // s: { hp, maxHp, score, alive, fps, showFps, fogWarning }
  update(s, dt) {
    const hpTarget = Math.max(0, s.hp / s.maxHp);
    this._hpShown += (hpTarget - this._hpShown) * (1 - Math.exp(-12 * dt));
    this.hpFill.scale.x = Math.max(0, this._hpShown);

    // Fog warning vignette: ease presence toward on/off, and pulse while on.
    this._warnT += dt;
    this._fogShown += ((s.fogWarning ? 1 : 0) - this._fogShown) * (1 - Math.exp(-8 * dt));
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(this._warnT * 4));
    this.fogWarn.alpha = this._fogShown * pulse;

    this.score.text = `Score: ${s.score}`;
    this.alive.text = `Alive: ${s.alive}`;
    this.fps.text = s.showFps ? `FPS: ${s.fps}` : "";
    this.hpText.text = `${Math.ceil(Math.max(0, s.hp))} / ${s.maxHp}`;
  }
}
