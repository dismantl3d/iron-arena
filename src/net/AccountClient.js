// Client-side account credentials. The server owns all progression; the client only
// holds a persistent {accountId, token} pair (in localStorage) so a returning player
// is recognized as the SAME account. The token is a secret handed out once at account
// creation — the server stores only its hash. This is deliberately tiny and
// replaceable: a real login screen would just populate the same {accountId, token}.

const AUTH_KEY = "ironArena.auth";

export class AccountClient {
  load() {
    try { const v = JSON.parse(localStorage.getItem(AUTH_KEY)); return v && v.accountId ? v : {}; }
    catch { return {}; }
  }
  save(accountId, token) {
    try { localStorage.setItem(AUTH_KEY, JSON.stringify({ accountId, token })); } catch { /* private mode */ }
  }
  clear() {
    try { localStorage.removeItem(AUTH_KEY); } catch { /* ignore */ }
  }
  // The auth message to send: existing creds if we have them, else a fresh request
  // carrying just the display name (the server mints a new guest account + token).
  authMessage(displayName) {
    const c = this.load();
    return { t: "auth", accountId: c.accountId, token: c.token, name: displayName };
  }
}
