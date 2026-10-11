// Snapshot expansion — shared by the browser client (MultiplayerMode) and the headless test clients.
//
// To save bandwidth the server trims `state` snapshots (see Match.#broadcastState):
//   • a participant's identity/cosmetic fields (name, type, color, weapon, wrap, trail, killFx, title,
//     maxHp, r …) are sent ONCE, when that participant first appears for a recipient;
//   • afterwards only the moving state (id, x, y, rot, hp, alive, heat, beam [+ own `up`]) is sent;
//   • crates/pickups are sent only when they change.
// expandSnapshot() rebuilds full records so the renderer / tests see the same shape as always.
// Pure data in, data out — no Pixi, no DOM.

export function createSnapshotCache() {
  return { meta: new Map(), pickups: null, crates: null };
}

export function expandSnapshot(snap, cache) {
  const players = snap.players;
  for (let i = 0; i < players.length; i++) {
    const sp = players[i];
    if (sp.name !== undefined) { // first sight: remember the static part
      const { up, x, y, rot, hp, alive, heat, beam, ...stat } = sp;
      cache.meta.set(sp.id, stat);
    } else {
      const stat = cache.meta.get(sp.id);
      if (stat) players[i] = { ...stat, ...sp };
    }
  }
  if (snap.pickups === undefined) snap.pickups = cache.pickups || []; else cache.pickups = snap.pickups;
  if (snap.crates === undefined) snap.crates = cache.crates || []; else cache.crates = snap.crates;
  return snap;
}
