'use strict';

const store = require('./store');

// How long each card has spent working, waiting on you, idle and queued, for
// the split under its status. Saved as status-times.json, so a restart keeps
// the totals.
//
// Every card's time is added up from the status changes seen here: each
// status is a segment, and a change closes it. Time before Tabherd first saw
// a card isn't known, apart from Claude's sessions: their transcripts log how
// long each turn took, from the prompt to the end of the reply. A turn
// includes any wait for you, so a Claude session's working time is its turns
// less the waiting seen here, and its idle time is the rest of its run.

const STATUSES = ['busy', 'shell', 'waiting', 'queued', 'idle'];
// Starting counts as idle.
const statusOf = (s) => (s === 'unknown' ? 'idle' : STATUSES.includes(s) ? s : null);
const BUCKET = { busy: 'working', shell: 'working', waiting: 'waiting', queued: 'queued', idle: 'idle' };
// Cards not seen for this long are forgotten.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// How often a card that's only being seen, not changing, is saved.
const SEEN_SAVE_MS = 60 * 1000;

const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));
const zero = () => Object.fromEntries(STATUSES.map((s) => [s, 0]));

function load() {
  const saved = store.read('status-times', null);
  const list = Array.isArray(saved?.cards) ? saved.cards : [];
  const entries = new Map();
  for (const c of list) {
    if (typeof c?.id !== 'string' || !STATUSES.includes(c.status) || !Number.isFinite(c.since)) continue;
    const totals = zero();
    for (const s of STATUSES) totals[s] = Math.max(0, Number(c.totals?.[s]) || 0);
    entries.set(c.id, { status: c.status, since: c.since, run: Number.isFinite(c.run) ? c.run : null, seen: Number(c.seen) || c.since, totals });
  }
  return entries;
}

let entries = null;
let savedAt = 0;

function save(now) {
  for (const [id, e] of entries) if (now - e.seen > KEEP_MS) entries.delete(id);
  try {
    store.write('status-times', { cards: [...entries].map(([id, e]) => ({ id, ...e })) });
    savedAt = now;
  } catch {
    // Kept in memory; tried again at the next change.
  }
}

// When the card took on its status: its own statusSince when that falls
// inside the segment that's ending, else now.
function changedAt(a, from, now) {
  const at = ms(a.statusSince);
  return Number.isFinite(at) && at >= from && at <= now ? at : now;
}

// How long a Claude session's turns took in this run, the open one so far.
function claudeTurns(a, run, now) {
  let total = 0;
  for (const [end, took] of a.turns) if (end >= run) total += took;
  const open = ms(a.turnStartedAt);
  if ((a.status === 'busy' || a.status === 'waiting') && Number.isFinite(open) && open >= run) total += Math.max(0, now - open);
  return total;
}

// Puts `times` on each card that has a status to split: milliseconds in each
// of working, waiting, idle and queued as of `at`, and `live`, the one still
// growing.
function observe(agents, now = Date.now()) {
  entries ||= load();
  let changed = false;
  for (const a of agents) {
    const status = statusOf(a.status);
    if (!status || !a.id) continue;
    const run = Number.isFinite(ms(a.startedAt)) ? ms(a.startedAt) : null;
    let e = entries.get(a.id);
    // A session resumed in a new run starts again.
    if (e && run !== null && e.run !== null && run !== e.run) e = null;
    if (!e) {
      const at = ms(a.statusSince);
      e = { status, since: Number.isFinite(at) && at <= now ? at : now, run, seen: now, totals: zero() };
      entries.set(a.id, e);
      changed = true;
    } else if (e.status !== status) {
      const at = changedAt(a, e.since, now);
      e.totals[e.status] += at - e.since;
      e.status = status;
      e.since = at;
      changed = true;
    }
    e.seen = now;

    const t = { ...e.totals };
    t[e.status] += Math.max(0, now - e.since);
    const times = { working: t.busy + t.shell, waiting: t.waiting, idle: t.idle, queued: t.queued };
    if (a.app === 'claude' && run !== null && Array.isArray(a.turns)) {
      // A background shell runs between turns: working, but not in them.
      const inTurns = claudeTurns(a, run, now);
      times.working = Math.max(0, inTurns - t.waiting) + t.shell;
      times.idle = Math.max(0, now - run - inTurns - t.shell);
    }
    a.times = { ...times, live: BUCKET[status], at: now };
  }
  if (changed || (agents.length && now - savedAt > SEEN_SAVE_MS)) save(now);
}

module.exports = { observe };
