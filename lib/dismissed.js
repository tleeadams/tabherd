'use strict';

const store = require('./store');

// Failed jobs, chats and downloads cleared from the dashboard, by card ID, so
// they stay cleared after a restart and in every browser. Saved as
// dismissed.json; the latest 500 are kept, which outlasts the day a failure
// is shown for.

const MAX = 500;

function load() {
  const saved = store.read('dismissed', null);
  const list = Array.isArray(saved?.ids) ? saved.ids.filter((x) => typeof x?.id === 'string' && x.id.length <= 300) : [];
  return new Map(list.map((x) => [x.id, Number(x.at) || 0]));
}

let ids = load();

function add(id, now = Date.now()) {
  const next = new Map(ids);
  next.set(id, now);
  const kept = [...next].sort((a, b) => b[1] - a[1]).slice(0, MAX);
  store.write('dismissed', { ids: kept.map(([i, at]) => ({ id: i, at })) });
  ids = new Map(kept);
}

const has = (id) => ids.has(id);

module.exports = { add, has };
