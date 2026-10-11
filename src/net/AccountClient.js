// Client side of the hosted accounts. The SERVER owns all progression; this file only holds
// credentials and asks the server to do things:
//
//   • guest identity    — {accountId, token} (issued once by the server) in localStorage
//   • registered login  — a revocable SESSION token in localStorage (never the password)
//
// Menu actions (register / login / resume / logout / devUnlock / syncLoadout) each use a
// short-lived socket: connect → authenticate → one request → close. The match connection
// (MultiplayerMode) authenticates itself with `authMessage()`.

const GUEST_KEY = "ironArena.auth";
const SESSION_KEY = "ironArena.session";

export function serverUrl() {
  // VITE_SERVER_URL wins (production, e.g. wss://play.example.com); else same host on :8080.
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return import.meta.env.VITE_SERVER_URL || `${proto}//${location.hostname}:8080`;
}

const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const del = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

export class AccountClient {
  // --- credentials ---
  loadGuest() { const v = read(GUEST_KEY); return v && v.accountId ? v : {}; }
  saveGuest(accountId, token) { write(GUEST_KEY, { accountId, token }); }
  clearGuest() { del(GUEST_KEY); }
  loadSession() { const v = read(SESSION_KEY); return v && v.sessionToken ? v.sessionToken : null; }
  saveSession(sessionToken) { write(SESSION_KEY, { sessionToken }); }
  clearSession() { del(SESSION_KEY); }
  hasSession() { return !!this.loadSession(); }
  hasAnyCredentials() { return this.hasSession() || !!this.loadGuest().accountId; }

  // The first message the MATCH socket sends: resume a login session if we have one,
  // otherwise authenticate as a guest (a fresh guest if no creds). No XP/progress is sent —
  // the server is the only source of truth for it.
  authMessage(displayName) {
    const session = this.loadSession();
    if (session) return { t: "resume", sessionToken: session };
    const g = this.loadGuest();
    return { t: "auth", accountId: g.accountId, token: g.token, name: displayName };
  }

  // Persist whatever credentials an authOk carries (never for a non-persistent guest).
  adoptAuthOk(m) {
    if (!m || m.ephemeral) return;
    if (m.sessionToken) { this.saveSession(m.sessionToken); if (m.kind === "registered") this.clearGuest(); }
    else if (m.token) this.saveGuest(m.accountId, m.token);
  }

  // --- one-shot request socket ---
  // run(fn) opens a socket, gives fn an `ask(msg, ...replyTypes)` helper, and always closes it.
  async #run(fn, timeoutMs = 6000) {
    let ws;
    try { ws = new WebSocket(serverUrl()); } catch { return { ok: false, reason: "network" }; }
    const waiters = [];
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].types.includes(m.t)) { const [w] = waiters.splice(i, 1); w.res(m); }
    };
    const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("network")); ws.onclose = () => rej(new Error("network")); });
    const ask = async (msg, ...types) => {
      await opened;
      return new Promise((res, rej) => {
        waiters.push({ types, res });
        setTimeout(() => rej(new Error("timeout")), timeoutMs);
        ws.send(JSON.stringify(msg));
      });
    };
    try { return await fn(ask); }
    catch { return { ok: false, reason: "network" }; }
    finally { try { ws.close(); } catch { /* ignore */ } }
  }

  // Authenticate the one-shot socket: session first, then guest creds (creating a guest if needed).
  async #bootstrap(ask, displayName) {
    const session = this.loadSession();
    if (session) {
      const r = await ask({ t: "resume", sessionToken: session }, "authOk", "authErr");
      if (r.t === "authOk") return r;
      if (r.reason === "bad-session") this.clearSession(); else return r; // unavailable / rate-limited: stop
    }
    const g = this.loadGuest();
    let r = await ask({ t: "auth", accountId: g.accountId, token: g.token, name: displayName }, "authOk", "authErr");
    if (r.t === "authErr" && (r.reason === "bad-token" || r.reason === "use-login")) {
      this.clearGuest();
      r = await ask({ t: "auth", name: displayName }, "authOk", "authErr");
    }
    if (r.t === "authOk") this.adoptAuthOk(r);
    return r;
  }

  #result(r) {
    if (r.ok === false) return r;
    if (r.t === "authOk") return { ok: true, profile: r.profile, kind: r.kind, ephemeral: !!r.ephemeral };
    return { ok: false, reason: r.reason || "failed" };
  }

  // --- actions (each resolves {ok, profile?, reason?}) ---
  // Create an account. A current guest account is UPGRADED in place (progress kept).
  register(username, password, displayName) {
    return this.#run(async (ask) => {
      const boot = await this.#bootstrap(ask, displayName);
      if (boot.t !== "authOk") return this.#result(boot);
      const r = await ask({ t: "register", username, password }, "authOk", "authErr");
      if (r.t === "authOk") this.adoptAuthOk(r);
      return this.#result(r);
    });
  }

  login(username, password) {
    return this.#run(async (ask) => {
      const r = await ask({ t: "login", username, password }, "authOk", "authErr");
      if (r.t === "authOk") this.adoptAuthOk(r);
      return this.#result(r);
    });
  }

  // Silent re-login from a stored session (app start). {ok:false, reason:"bad-session"} = expired.
  resume() {
    return this.#run(async (ask) => {
      const session = this.loadSession();
      if (!session) return { ok: false, reason: "no-session" };
      const r = await ask({ t: "resume", sessionToken: session }, "authOk", "authErr");
      if (r.t === "authErr" && r.reason === "bad-session") this.clearSession();
      return this.#result(r);
    });
  }

  async logout() {
    const sessionToken = this.loadSession();
    this.clearSession();
    if (!sessionToken) return { ok: true };
    return this.#run(async (ask) => { await ask({ t: "logout", sessionToken }, "loggedOut"); return { ok: true }; });
  }

  // DEV: ask the server to unlock everything (honored only if the server enables it).
  devUnlock(displayName) {
    return this.#run(async (ask) => {
      const boot = await this.#bootstrap(ask, displayName);
      if (boot.t !== "authOk") return this.#result(boot);
      const r = await ask({ t: "devUnlock" }, "profile");
      return { ok: r.devUnlock === true, profile: r.profile, reason: r.devUnlock ? undefined : "disabled" };
    });
  }

  // Persist the player's equipped loadout (+ display name) on their account.
  syncLoadout(profile) {
    return this.#run(async (ask) => {
      const boot = await this.#bootstrap(ask, profile.displayName);
      if (boot.t !== "authOk") return this.#result(boot);
      const r = await ask({ t: "setLoadout", name: profile.username, weapon: profile.weapon, color: profile.cosmetic, wrap: profile.wrap, trail: profile.trail, killFx: profile.killFx, title: profile.title }, "profile");
      return { ok: true, profile: r.profile };
    });
  }
}
