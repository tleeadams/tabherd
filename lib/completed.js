'use strict';

const store = require('./store');

// Sessions marked complete, by session ID, so History can tell work that's
// done from work that was only closed. Saved as completed.json. Each keeps
// when it was marked and how many prompts the session had then: one resumed
// and asked more is no longer complete. The latest 2000 are kept, more than
// History holds.

const MAX = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function load() {
  const saved = store.read('completed', null);
  const list = Array.isArray(saved?.sessions) ? saved.sessions.filter((s) => UUID.test(s?.id) && Number.isFinite(s.at)) : [];
  return new Map(list.map((s) => [s.id, { at: s.at, prompts: Number(s.prompts) || 0 }]));
}

let marks = load();

// Writes first and only then keeps the change, so a failed write changes nothing.
function commit(next) {
  const kept = [...next].sort((a, b) => b[1].at - a[1].at).slice(0, MAX);
  store.write('completed', { sessions: kept.map(([id, m]) => ({ id, ...m })) });
  marks = new Map(kept);
}

function add(id, prompts, now = Date.now()) {
  if (!UUID.test(id)) return;
  commit(new Map(marks).set(id, { at: now, prompts: prompts || 0 }));
}

function remove(id) {
  if (!marks.has(id)) return;
  const next = new Map(marks);
  next.delete(id);
  commit(next);
}

// When the session was marked complete, or null.
const at = (id) => marks.get(id)?.at ?? null;

// Called with each snapshot: a complete session that's running again and has
// been asked more since is no longer complete.
function observe(agents) {
  let next = null;
  for (const a of agents) {
    const m = marks.get(a.id);
    if (m && (a.prompts || 0) > m.prompts) (next ||= new Map(marks)).delete(a.id);
  }
  if (next) commit(next);
}

module.exports = { add, remove, at, observe };
