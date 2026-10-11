// Account panel: log in / create an account / log out. Deliberately tiny and built from the
// existing flat components (ia-panel / ia-input / ia-btn / ia-note) — no new visual language.
// It only collects credentials and reports the result; the SERVER decides everything (the
// panel never touches XP/currency/unlocks).

import { el } from "./dom.js";

const REASONS = {
  "username-invalid": "Username must be 3–16 letters, numbers, _ or -.",
  "password-invalid": "Password must be 8–128 characters.",
  "username-taken": "That username is already taken.",
  "bad-credentials": "Wrong username or password.",
  "rate-limited": "Too many attempts — wait a minute and try again.",
  unavailable: "The account service is temporarily unavailable.",
  network: "Can't reach the game server.",
};

export class AccountPanel {
  // hooks: { onClose(), onSignedIn(profileWire, {adoptLoadout}), onSignedOut() }
  constructor(profile, accountClient, hooks) {
    this.profile = profile;
    this.client = accountClient;
    this.hooks = hooks;
    this.busy = false;

    this.user = el("input", { class: "ia-input", attrs: { type: "text", maxlength: "16", placeholder: "Username", autocomplete: "username" } });
    this.pass = el("input", { class: "ia-input", attrs: { type: "password", maxlength: "128", placeholder: "Password (8+ characters)", autocomplete: "current-password" } });
    this.msg = el("div", { class: "ia-note ia-acct-msg" });
    this.who = el("div", { class: "ia-note" });

    this.loginBtn = el("button", { class: "ia-btn ia-primary", text: "LOG IN", on: { click: () => this.#submit("login") } });
    this.createBtn = el("button", { class: "ia-btn", text: "CREATE ACCOUNT", on: { click: () => this.#submit("register") } });
    this.logoutBtn = el("button", { class: "ia-btn", text: "LOG OUT", on: { click: () => this.#logout() } });
    this.form = el("div", { class: "ia-col" }, [this.user, this.pass, this.loginBtn, this.createBtn]);
    this.signedIn = el("div", { class: "ia-col" }, [this.who, this.logoutBtn]);

    this.card = el("div", { class: "ia-panel ia-acct-panel" }, [
      el("h2", { text: "ACCOUNT" }),
      this.msg,
      this.form,
      this.signedIn,
      el("button", { class: "ia-btn", text: "Back", on: { click: () => this.hooks.onClose() } }),
    ]);
    this.root = el("div", { class: "ia-overlay ia-scrim ia-hidden" }, [this.card]);
    document.body.appendChild(this.root);
    for (const i of [this.user, this.pass]) i.addEventListener("keydown", (e) => { if (e.key === "Enter") this.#submit("login"); e.stopPropagation(); });
  }

  show() {
    this.#render();
    this.root.classList.remove("ia-hidden");
  }
  hide() {
    this.root.classList.add("ia-hidden");
  }

  #render(message = "") {
    const registered = this.profile.online && this.profile.accountKind === "registered";
    this.form.classList.toggle("ia-hidden", registered);
    this.signedIn.classList.toggle("ia-hidden", !registered);
    this.who.textContent = registered ? `Logged in as ${this.profile.accountName}` : "";
    this.msg.textContent = message || (registered
      ? "Your progress is saved on the server and follows you to any device."
      : "Log in to keep your progress on any device. Creating an account keeps what you have now.");
    for (const b of [this.loginBtn, this.createBtn, this.logoutBtn]) b.disabled = this.busy;
  }

  async #submit(kind) {
    if (this.busy) return;
    const username = this.user.value.trim();
    const password = this.pass.value;
    if (!username || !password) { this.#render("Enter a username and password."); return; }
    this.busy = true; this.#render("Working…");
    const res = kind === "login"
      ? await this.client.login(username, password)
      : await this.client.register(username, password, this.profile.username);
    this.busy = false;
    if (!res.ok) { this.#render(REASONS[res.reason] || "Something went wrong."); return; }
    this.pass.value = "";
    this.hooks.onSignedIn(res.profile, { adoptLoadout: true }); // a login restores the account's saved loadout
    this.#render(kind === "login" ? "Logged in." : "Account created.");
  }

  async #logout() {
    if (this.busy) return;
    this.busy = true; this.#render("Logging out…");
    await this.client.logout();
    this.busy = false;
    this.hooks.onSignedOut();
    this.#render("Logged out.");
  }
}
