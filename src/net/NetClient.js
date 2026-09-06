// Thin WebSocket client for the authoritative multiplayer server. It only sends
// INTENT (join / input / respawn / ping) and surfaces server messages via
// callbacks — it never decides gameplay outcomes. Fails gracefully: connection
// errors and drops are reported through `onStatus` instead of throwing.

export class NetClient {
  // url e.g. "ws://localhost:8080". handlers: { onWelcome, onState, onKill, onLeave, onStatus }
  constructor(url, handlers = {}) {
    this.url = url;
    this.h = handlers;
    this.ws = null;
    this.connected = false;
    this.ping = 0;
    this._pingSent = 0;
    this._pingTimer = null;
    this._closedByUs = false;
  }

  connect() {
    this._closedByUs = false;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.#status("error", String(e));
      return;
    }
    this.ws = ws;
    this.#status("connecting");

    ws.onopen = () => {
      this.connected = true;
      this.#status("connected");
      this.h.onOpen?.(); // caller authenticates, then joins
      this._pingTimer = setInterval(() => this.#doPing(), 2000);
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || typeof m.t !== "string") return;
      switch (m.t) {
        case "authOk": this.h.onAuthOk?.(m); break;
        case "authErr": this.h.onAuthErr?.(m); break;
        case "profile": this.h.onProfile?.(m); break;
        case "welcome": this.h.onWelcome?.(m); break;
        case "state": this.h.onState?.(m); break;
        case "matchStart": this.h.onMatchStart?.(m); break;
        case "lobby": this.h.onLobby?.(m); break;
        case "kill": this.h.onKill?.(m); break;
        case "winner": this.h.onWinner?.(m); break;
        case "leave": this.h.onLeave?.(m); break;
        case "pong": if (m.id === this._pingSent) this.ping = Math.round(performance.now() - this._pingAt); break;
      }
    };
    ws.onerror = () => this.#status("error", "socket error");
    ws.onclose = () => {
      this.connected = false;
      clearInterval(this._pingTimer);
      this.#status(this._closedByUs ? "closed" : "disconnected");
    };
  }

  send(obj) {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch { /* dropped */ }
    }
  }

  auth(msg) { this.send({ t: "auth", ...msg }); }
  join(msg) { this.send({ t: "join", ...msg }); }

  // `seq` is a monotonically increasing input sequence number; the server echoes the
  // latest processed seq back as `ack` in state snapshots (client-authoritative input,
  // server-authoritative results).
  sendInput(mx, my, aim, fire, detonate, seq) {
    this.send({ t: "input", seq, mx, my, aim, fire, detonate });
  }

  requestRespawn() {
    this.send({ t: "respawn" });
  }

  #doPing() {
    this._pingSent = (this._pingSent || 0) + 1;
    this._pingAt = performance.now();
    this.send({ t: "ping", id: this._pingSent });
  }

  #status(state, detail) {
    this.h.onStatus?.(state, detail);
  }

  close() {
    this._closedByUs = true;
    clearInterval(this._pingTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.connected = false;
  }
}
