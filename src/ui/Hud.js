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

    // top-left stack
    this.score = this.#text(24, "bold", COLORS.hudText);
    this.alive = this.#text(17, "bold", COLORS.hudText);
    this.fps = this.#text(15, "normal", COLORS.hudDim);

    // bottom-center HP bar
    this.hpBg = new Graphics().roundRect(0, 0, BAR_W, HP_H, 6).fill(COLORS.hpBg);
    this.hpFill = new Graphics().roundRect(0, 0, BAR_W, HP_H, 6).fill(COLORS.hpFill);
    this.hpText = this.#text(12, "bold", COLORS.hudText);
    this.hpText.anchor.set(0.5);

    this.view.addChild(this.score, this.alive, this.fps, this.hpBg, this.hpFill, this.hpText);

    this._hpShown = 1; // animated bar fill

    this.layout();
  }

  #text(size, weight, fill) {
    return new Text({
      text: "",
      style: { fill, fontFamily: "Arial", fontSize: size, fontWeight: weight },
    });
  }

  layout() {
    const W = this.app.screen.width;
    const H = this.app.screen.height;

    this.score.position.set(16, 12);
    this.alive.position.set(16, 46);
    this.fps.position.set(16, 72);

    const cx = Math.round((W - BAR_W) / 2);
    const hpY = H - 34;
    this.hpBg.position.set(cx, hpY);
    this.hpFill.position.set(cx, hpY);
    this.hpText.position.set(W / 2, hpY + HP_H / 2);
  }

  // s: { hp, maxHp, score, alive, fps, showFps }
  update(s, dt) {
    const hpTarget = Math.max(0, s.hp / s.maxHp);
    this._hpShown += (hpTarget - this._hpShown) * (1 - Math.exp(-12 * dt));
    this.hpFill.scale.x = Math.max(0, this._hpShown);

    this.score.text = `Score: ${s.score}`;
    this.alive.text = `Alive: ${s.alive}`;
    this.fps.text = s.showFps ? `FPS: ${s.fps}` : "";
    this.hpText.text = `${Math.ceil(Math.max(0, s.hp))} / ${s.maxHp}`;
  }
}
