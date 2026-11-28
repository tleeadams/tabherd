'use strict';

// The tickets on cards. ticket-refs.js finds which tickets each session is
// about: its branch, the Claim: lines and links in what it was asked and
// said, and its to-do's. Each is looked up in the trackers Settings →
// Tickets has, and linked in each that has it: no ticket, no link. What each
// session claimed, and the tickets added or taken off by hand, are kept in
// tickets.json, with the last status read of each ticket, so cards have
// them at once after a restart. See docs/ticket-links.md.

const store = require('./store');
const settings = require('./settings');
const trackers = require('./trackers');
const ticketRefs = require('./ticket-refs');
const { isSessionId } = require('./session-id');

const FRESH_MS = 5 * 60 * 1000;
const MISSING_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const AT_ONCE = 4;
const WAIT_MS = 12000;
const SAVE_DELAY_MS = 2000;
const SEEN_EVERY_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 1000;
const MAX_KNOWN = 2000;
const MAX_REFS = 50;
const SESSION_APPS = new Set(['claude', 'codex', 'copilot', 'opencode', 'cursor', 'antigravity']);

// The trackers in Settings → Tickets; tests give their own.
let trackerList = () => settings.get().trackers || [];
const useTrackers = (fn) => {
  trackerList = fn;
};

// ---- what's kept -----------------------------------------------------------------

function cleanRef(r) {
  if (!r || typeof r.key !== 'string' || r.key.length > 200) return null;
  if (r.hint !== null && r.hint !== undefined && (typeof r.hint !== 'string' || r.hint.length > 100)) return null;
  return { key: r.key, hint: r.hint || null };
}
const strings = (list, max) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.length <= 300).slice(-max) : []);
const refList = (list) => (Array.isArray(list) ? list.map(cleanRef).filter(Boolean).slice(-MAX_REFS) : []);

function load() {
  const saved = store.read('tickets', null);
  const sessions = {};
  for (const [id, r] of Object.entries(saved?.sessions || {})) {
    if (!isSessionId(id) || !r || typeof r !== 'object') continue;
    sessions[id] = { claims: refList(r.claims), manual: refList(r.manual), dropped: strings(r.dropped, MAX_REFS), removed: strings(r.removed, MAX_REFS), seen: Number(r.seen) || 0 };
  }
  const known = {};
  for (const [id, k] of Object.entries(saved?.known || {})) {
    if (typeof id === 'string' && k?.ticket && typeof k.ticket.key === 'string' && Number.isFinite(k.at)) known[id] = { ticket: k.ticket, at: k.at };
  }
  return { sessions, known };
}

let data = load();
// Each lookup's last answer, by "<tracker ID> <key>": { ticket, at },
// { missing: true, at }, or with error and errorAt when it couldn't say.
const lookups = new Map(Object.entries(data.known));
const pending = new Map();
const queue = [];
let running = 0;
// Each tracker's last problem: { error, auth, at }.
const problems = new Map();
let saveTimer = null;

function write() {
  const newest = (obj, at, max) =>
    Object.fromEntries(
      Object.entries(obj)
        .sort(([, a], [, b]) => at(b) - at(a))
        .slice(0, max),
    );
  data = { sessions: newest(data.sessions, (r) => r.seen, MAX_SESSIONS), known: newest(data.known, (k) => k.at, MAX_KNOWN) };
  try {
    store.write('tickets', data);
  } catch {}
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    write();
  }, SAVE_DELAY_MS);
  saveTimer.unref?.();
}

function record(id, now = Date.now()) {
  if (!data.sessions[id]) data.sessions[id] = { claims: [], manual: [], dropped: [], removed: [], seen: now };
  return data.sessions[id];
}

const sameRef = (a, b) => a.key === b.key && (a.hint || null) === (b.hint || null);

// Claim and Unclaim, in order. Replaying the same ones again changes
// nothing, so a transcript read again from the start is fine.
function apply(r, ops) {
  for (const op of ops) {
    const ref = cleanRef(op);
    if (!ref) continue;
    if (op.op === 'unclaim') {
      r.claims = r.claims.filter((x) => x.key !== ref.key);
      r.manual = r.manual.filter((x) => x.key !== ref.key);
      if (!r.dropped.includes(ref.key)) r.dropped.push(ref.key);
    } else {
      if (!r.claims.some((x) => sameRef(x, ref))) r.claims.push(ref);
      r.dropped = r.dropped.filter((k) => k !== ref.key);
    }
  }
  r.claims = r.claims.slice(-MAX_REFS);
  r.dropped = r.dropped.slice(-MAX_REFS);
}

// ---- where each ticket is looked up ----------------------------------------------------

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

// Whether a ref's hint names this tracker: its type, its name, or the
// address a link was on.
function named(hint, t) {
  if (!hint) return true;
  if (hint.startsWith('host:')) return hostOf(t.url) === hint.slice(5);
  return hint === t.type || hint === t.name.toLowerCase() || (t.type === 'github' && ['github issues', 'gh'].includes(hint));
}

// The trackers a ref could be in, and its key in each: [{ t, key }]. "#12"
// is a Zendesk ticket where a Zendesk tracker is named, else an issue in the
// session's GitHub repository.
function where(ref, list, github) {
  const key = ref.key;
  const is = (type) => list.filter((t) => t.type === type && named(ref.hint, t));
  const m = key.match(/^([A-Z][A-Z0-9_]*)-\d+$/);
  if (m) return list.filter((t) => (t.type === 'jira' || t.type === 'linear') && named(ref.hint, t) && (!t.prefixes.length || t.prefixes.includes(m[1]))).map((t) => ({ t, key }));
  if (/^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+#\d+$/.test(key)) return is('github').map((t) => ({ t, key }));
  if (/^#\d+$/.test(key)) {
    const zendesk = ref.hint ? is('zendesk') : [];
    if (zendesk.length) return zendesk.map((t) => ({ t, key }));
    return github ? is('github').map((t) => ({ t, key: `${github}${key}` })) : [];
  }
  return [];
}

// ---- looking up -------------------------------------------------------------------------

// Whether a lookup's answer is still good: a ticket for five minutes, none
// for an hour, and after a failure, a minute before trying again.
function fresh(info, now) {
  if (!info) return false;
  if (info.errorAt && now - info.errorAt < RETRY_MS) return true;
  if (info.missing) return now - info.at < MISSING_MS;
  return Boolean(info.ticket) && now - info.at < FRESH_MS;
}

function pump() {
  while (running < AT_ONCE && queue.length) {
    const job = queue.shift();
    running++;
    trackers
      .read(job.t, job.key)
      .then((r) => {
        const at = Date.now();
        if (r.ok) {
          const ticket = { ...r.ticket, title: String(r.ticket.title || '').slice(0, 300) };
          lookups.set(job.id, { ticket, at });
          data.known[job.id] = { ticket, at };
          problems.delete(job.t.id);
          saveSoon();
        } else if (r.missing) {
          lookups.set(job.id, { missing: true, at });
          if (data.known[job.id]) {
            delete data.known[job.id];
            saveSoon();
          }
          problems.delete(job.t.id);
        } else {
          // Its last known status stays until it answers again.
          lookups.set(job.id, { ...(lookups.get(job.id) || { at: 0 }), error: r.error, errorAt: at });
          problems.set(job.t.id, { error: r.error, auth: Boolean(r.auth), at });
        }
      })
      .finally(() => {
        running--;
        const done = pending.get(job.id);
        pending.delete(job.id);
        done?.resolve();
        pump();
      });
  }
}

// Looks a ticket up unless its last answer is still good. Resolves once
// it's answered.
function want(t, key, now = Date.now()) {
  const id = `${t.id} ${key}`;
  if (pending.has(id)) return pending.get(id).promise;
  if (fresh(lookups.get(id), now)) return Promise.resolve();
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  pending.set(id, { promise, resolve });
  queue.push({ t, key, id });
  pump();
  return promise;
}

// ---- a session's tickets --------------------------------------------------------------

// The tickets linked to a session or to-do, as chips: { id, tracker,
// trackerName, type, key, title, status, category, assignee, url }. Ones not
// looked up yet are asked for, and show once they're found.
function linked(subject, r, list, now, { branch = true } = {}) {
  const repo = ticketRefs.repoOf(subject.cwd, now);
  const dropped = new Set(r?.dropped || []);
  const removed = new Set(r?.removed || []);
  const all = [
    ...(branch ? ticketRefs.inBranch(subject.gitBranch || repo.branch) : []),
    ...refList(subject.todo?.ticketRefs),
    ...(r?.claims || []),
    ...(r?.manual || []),
  ];
  const chips = [];
  for (const ref of all) {
    if (dropped.has(ref.key)) continue;
    for (const { t, key } of where(ref, list, repo.github)) {
      want(t, key, now);
      const ticket = lookups.get(`${t.id} ${key}`)?.ticket;
      if (!ticket) continue;
      const id = `${t.id} ${ticket.key}`;
      if (removed.has(id) || chips.some((c) => c.id === id)) continue;
      chips.push({ id, tracker: t.id, trackerName: t.name, type: t.type, ...ticket });
    }
  }
  return chips;
}

// Each session's claims, as its transcript gave them, by session ID: the
// list and how much of it is applied. A new list (the transcript was read
// again) is applied from the start.
const applied = new Map();

// Called with each snapshot: records what each session claimed, and puts its
// tickets on its card as `tickets`.
function observe(agents, now = Date.now()) {
  const list = trackerList();
  const live = new Set();
  for (const a of agents) {
    const ops = Array.isArray(a.ticketRefs) ? a.ticketRefs : null;
    delete a.ticketRefs;
    if (!SESSION_APPS.has(a.app) || !isSessionId(a.id)) continue;
    live.add(a.id);
    if (ops?.length) {
      const last = applied.get(a.id);
      const unseen = last?.list === ops && ops.length >= last.n ? ops.slice(last.n) : ops;
      applied.set(a.id, { list: ops, n: ops.length });
      if (unseen.length) {
        const r = record(a.id, now);
        const before = JSON.stringify(r);
        apply(r, unseen);
        if (JSON.stringify(r) !== before) saveSoon();
      }
    }
    const r = data.sessions[a.id];
    if (r && now - r.seen > SEEN_EVERY_MS) {
      r.seen = now;
      saveSoon();
    }
    if (list.length) a.tickets = linked(a, r, list, now);
  }
  for (const id of applied.keys()) if (!live.has(id)) applied.delete(id);
}

// A to-do's tickets, as chips. A to-do isn't on its folder's branch yet.
function forTodo(todo, now = Date.now()) {
  const list = trackerList();
  if (!list.length || !todo.ticketRefs?.length) return [];
  return linked({ cwd: todo.cwd, todo }, null, list, now, { branch: false });
}

// What was typed into + Ticket or a to-do's Tickets field, as refs.
const parse = (text) => ticketRefs.itemsIn(String(text || '').slice(0, 2000));

const withTimeout = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, WAIT_MS).unref?.())]);

// Links what was pasted into a session's + Ticket: links or keys, as in a
// Claim: line. Waits for them to be looked up, to say which weren't found.
async function add(subject, text, now = Date.now()) {
  const refs = parse(text);
  if (!refs.length) return { ok: false, error: 'Paste a ticket link or key, such as ABC-123.' };
  const list = trackerList();
  if (!list.length) return { ok: false, error: 'Add your trackers in Settings → Tickets first.' };
  const repo = ticketRefs.repoOf(subject.cwd, now);
  const r = record(subject.id, now);
  const linkedKeys = [];
  const notFound = [];
  const unsure = [];
  for (const ref of refs) {
    const places = where(ref, list, repo.github);
    await withTimeout(Promise.all(places.map(({ t, key }) => want(t, key, now))));
    const answers = places.map(({ t, key }) => ({ t, info: lookups.get(`${t.id} ${key}`) }));
    const found = answers.filter((x) => x.info?.ticket);
    if (found.length) {
      for (const { t, info } of found) {
        r.removed = r.removed.filter((id) => id !== `${t.id} ${info.ticket.key}`);
        linkedKeys.push(info.ticket.key);
      }
    } else if (answers.length && answers.every((x) => x.info?.missing)) {
      notFound.push(ref.key);
      continue;
    } else if (!answers.length) {
      notFound.push(ref.key);
      continue;
    } else {
      unsure.push(ref.key);
    }
    if (!r.manual.some((x) => sameRef(x, ref))) r.manual.push(ref);
    r.dropped = r.dropped.filter((k) => k !== ref.key);
  }
  r.manual = r.manual.slice(-MAX_REFS);
  saveSoon();
  return { ok: true, linked: [...new Set(linkedKeys)], notFound, unsure };
}

// Takes a ticket's chip off a session's card, for good.
function remove(sessionId, chipId, now = Date.now()) {
  if (typeof chipId !== 'string' || chipId.length > 300) return { ok: false, error: 'Not a ticket.' };
  const r = record(sessionId, now);
  if (!r.removed.includes(chipId)) r.removed.push(chipId);
  r.removed = r.removed.slice(-MAX_REFS);
  saveSoon();
  return { ok: true };
}

// ---- a to-do from a ticket ------------------------------------------------------------

// A to-do's longest title and notes, as todos.js keeps them.
const TODO_TITLE = 200;
const TODO_NOTES = 20000;
const cut = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// What was pasted as a new to-do's title, if it's one ticket's link or key,
// read with its description: { ok: true, ticket: { key, title, description,
// trackerName } }, cut to fit a to-do. Anything else pasted answers { ok:
// true, ticket: null }. Read afresh, with only its status kept, so its chip
// shows at once.
async function describe(text, now = Date.now()) {
  const pasted = String(text || '').trim();
  const refs = /\s/.test(pasted) || pasted.length > 2000 ? [] : parse(pasted);
  // "#12" alone could be any repository's issue, or a Zendesk ticket.
  if (refs.length !== 1 || (refs[0].key.startsWith('#') && !refs[0].hint)) return { ok: true, ticket: null };
  const list = trackerList();
  if (!list.length) return { ok: false, error: 'Add your trackers in Settings → Tickets first.' };
  const answers = await Promise.all(where(refs[0], list, null).map(({ t, key }) => trackers.read(t, key, { description: true }).then((r) => ({ t, key, r }))));
  const found = answers.find((x) => x.r.ok);
  if (!found) return { ok: false, error: answers.find((x) => x.r.error)?.r.error || "That ticket wasn't found in your trackers." };
  const { description, ...ticket } = found.r.ticket;
  const known = { ticket: { ...ticket, title: ticket.title.slice(0, 300) }, at: now };
  lookups.set(`${found.t.id} ${found.key}`, known);
  data.known[`${found.t.id} ${found.key}`] = known;
  problems.delete(found.t.id);
  saveSoon();
  return { ok: true, ticket: { key: ticket.key, title: cut(ticket.title.replace(/\s+/g, ' ').trim() || ticket.key, TODO_TITLE), description: cut(description, TODO_NOTES), trackerName: found.t.name } };
}

// A tracker was changed or removed: what was read with its old sign-in goes.
function forget(trackerId) {
  for (const id of [...lookups.keys()]) if (id.startsWith(`${trackerId} `)) lookups.delete(id);
  for (const id of Object.keys(data.known)) if (id.startsWith(`${trackerId} `)) delete data.known[id];
  problems.delete(trackerId);
  saveSoon();
}

// ---- writing back on Complete --------------------------------------------------------

const MAX_COMMENT = 20000;

// For the Complete dialog: how each of a session's tickets could be moved to
// done. One that's already done or closed, or a pull request, isn't moved.
async function doneOptions(agent) {
  const list = trackerList();
  const tickets = await Promise.all(
    (agent.tickets || []).map(async (c) => {
      const t = list.find((x) => x.id === c.tracker);
      if (!t) return { chip: c.id, moves: [], error: 'That tracker is gone.' };
      if (c.pullRequest || c.category === 'done' || c.category === 'closed') return { chip: c.id, moves: [] };
      const r = (await withTimeout(trackers.doneMoves(t, c.key))) || { ok: false, error: "It didn't answer in time." };
      return r.ok ? { chip: c.id, moves: r.moves } : { chip: c.id, moves: [], error: r.error };
    }),
  );
  return { ok: true, tickets };
}

// Posts what the Complete dialog asked for, ticket by ticket: [{ chip,
// comment, publicReply, move }]. Only tickets on the session's card can be
// written to. Answers each one's result, with what was done before anything
// failed, so it isn't done twice when tried again.
async function writeBack(agent, writes) {
  if (!Array.isArray(writes) || writes.length > MAX_REFS) return { ok: false, error: 'Not a ticket.' };
  const list = trackerList();
  const results = [];
  for (const w of writes) {
    const chip = (agent.tickets || []).find((c) => c.id === w?.chip);
    const t = chip && list.find((x) => x.id === chip.tracker);
    if (!t) {
      results.push({ chip: typeof w?.chip === 'string' ? w.chip : null, ok: false, error: 'That ticket is no longer on its card.', done: [] });
      continue;
    }
    const comment = typeof w.comment === 'string' && w.comment.trim() ? w.comment.slice(0, MAX_COMMENT) : null;
    const move = typeof w.move === 'string' && w.move.length <= 100 && !chip.pullRequest ? w.move : null;
    const r = comment || move ? await trackers.write(t, chip.key, { comment, publicReply: w.publicReply === true, move }) : { ok: true, done: [] };
    results.push({ chip: chip.id, ok: r.ok, error: r.ok ? null : r.error, done: r.done || [] });
    // Read its status again, now it's changed.
    if (r.done?.length) {
      const id = `${t.id} ${chip.key}`;
      const info = lookups.get(id);
      if (info) lookups.set(id, { ...info, at: 0, errorAt: 0 });
      want(t, chip.key);
    }
  }
  return { ok: true, results };
}

// Each tracker's last problem, for Settings → Tickets: { [id]: { error, auth, at } }.
const problemsNow = () => Object.fromEntries(problems);

// Once every lookup asked for has answered.
const settled = () => Promise.all([...pending.values()].map((p) => p.promise));

module.exports = { observe, forTodo, add, remove, describe, forget, parse, doneOptions, writeBack, problems: problemsNow, where, apply, cleanRef, flush: write, useTrackers, settled };
