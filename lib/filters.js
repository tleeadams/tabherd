'use strict';

const crypto = require('crypto');
const store = require('./store');

// The filter tabs across the top of the dashboard, after All, which is always
// there. Each shows the cards that match everything it names: their status,
// their app, their group, their tickets' status, and words in their name or
// folder. A list left empty matches any. To-do cards show only under the
// filters that ask for them. Until they're changed, the tabs are the four the
// dashboard always had, and Ticket done, which shows once there's a tracker.

// Status groups, with Shell running apart from the rest of Working.
const STATUSES = ['needs', 'working', 'shell', 'idle'];
// A card's tickets' status, in the dashboard's groups for them, or none. A
// card with several goes by its least finished: closed counts as finished,
// without being done.
const TICKETS = ['todo', 'progress', 'done', 'closed', 'none'];
// filters.json's version. Version 1 had no Shell running of its own, and
// version 2 no tickets.
const VERSION = 3;
const APPS = ['claude', 'codex', 'copilot', 'opencode', 'cursor', 'comfy', 'localai', 'ollama', 'lmstudio', 'llamacpp'];
const MAX_FILTERS = 12;
const MAX_GROUPS = 20;
const NAME_MAX = 24;
const TEXT_MAX = 100;
const ID = /^[A-Za-z0-9_-]{1,40}$/;

// A session whose work its tickets say is finished, which may be ready to close.
const TICKET_DONE = { id: 'ticket-done', name: 'Ticket done', statuses: [], apps: [], groups: [], tickets: ['done', 'closed'], todos: false, text: '' };

const DEFAULTS = [
  { id: 'todo', name: 'Todo', statuses: ['needs', 'idle'], apps: [], groups: [], tickets: [], todos: true, text: '' },
  { id: 'needs', name: 'Needs you', statuses: ['needs'], apps: [], groups: [], tickets: [], todos: false, text: '' },
  { id: 'working', name: 'Working', statuses: ['working', 'shell'], apps: [], groups: [], tickets: [], todos: false, text: '' },
  { id: 'idle', name: 'Idle', statuses: ['idle'], apps: [], groups: [], tickets: [], todos: false, text: '' },
  TICKET_DONE,
];

// Each of `given` that's one of `allowed`, once, in the order given.
const pick = (given, allowed) => [...new Set((Array.isArray(given) ? given : []).filter((x) => allowed(x)))];

// A filter as given, cleaned, or a reason it can't be saved.
function cleanFilter(f) {
  if (!f || typeof f !== 'object') return { error: 'Not a filter.' };
  const name = typeof f.name === 'string' ? f.name.replace(/\s+/g, ' ').trim() : '';
  if (!name) return { error: 'A filter needs a name.' };
  if (name.length > NAME_MAX) return { error: `Keep filter names to ${NAME_MAX} characters.` };
  if (name.toLowerCase() === 'all') return { error: 'All is already there.' };
  const text = typeof f.text === 'string' ? f.text.replace(/\s+/g, ' ').trim() : '';
  if (text.length > TEXT_MAX) return { error: `Keep the words to ${TEXT_MAX} characters.` };
  const groups = pick(f.groups, (g) => typeof g === 'string' && ID.test(g));
  if (groups.length > MAX_GROUPS + 1) return { error: 'Too many groups.' };
  return {
    filter: {
      id: typeof f.id === 'string' && ID.test(f.id) ? f.id : crypto.randomUUID(),
      name,
      statuses: pick(f.statuses, (s) => STATUSES.includes(s)),
      apps: pick(f.apps, (a) => APPS.includes(a)),
      groups,
      tickets: pick(f.tickets, (s) => TICKETS.includes(s)),
      todos: f.todos === true,
      text,
    },
  };
}

// Filters saved before Shell running could be picked on its own counted it as
// Working, so one that picks Working picks it too. Ticket done is added once,
// to the filters saved before it, if there's room and none has its name; once
// they're saved again, deleting it keeps it gone.
function upgrade(saved) {
  let list = saved.filters;
  if (!(saved.version >= 2)) {
    list = list.map((f) =>
      Array.isArray(f?.statuses) && f.statuses.includes('working') && !f.statuses.includes('shell') ? { ...f, statuses: [...f.statuses, 'shell'] } : f,
    );
  }
  const named = (f) => f?.id === TICKET_DONE.id || (typeof f?.name === 'string' && f.name.trim().toLowerCase() === TICKET_DONE.name.toLowerCase());
  if (!(saved.version >= 3) && list.length < MAX_FILTERS && !list.some(named)) list = [...list, TICKET_DONE];
  return list;
}

function load() {
  const saved = store.read('filters', null);
  if (!Array.isArray(saved?.filters)) return DEFAULTS;
  const filters = [];
  for (const f of upgrade(saved)) {
    const { filter } = cleanFilter(f);
    if (filter && filters.length < MAX_FILTERS && !filters.some((x) => x.id === filter.id)) filters.push(filter);
  }
  return filters;
}

let state = load();

const list = () => state;

// Replaces every filter, in the order given, as the page saves them.
function setFilters(given) {
  if (!Array.isArray(given)) return { ok: false, error: 'Expected a list of filters.' };
  if (given.length > MAX_FILTERS) return { ok: false, error: `Up to ${MAX_FILTERS} filters, besides All.` };
  const filters = [];
  for (const f of given) {
    const { filter, error } = cleanFilter(f);
    if (error) return { ok: false, error };
    if (filters.some((x) => x.id === filter.id)) return { ok: false, error: 'Two filters have the same ID.' };
    if (filters.some((x) => x.name.toLowerCase() === filter.name.toLowerCase())) return { ok: false, error: `There's already a filter called ${filter.name}.` };
    filters.push(filter);
  }
  try {
    store.write('filters', { version: VERSION, filters });
  } catch (err) {
    return { ok: false, error: `Couldn't save the filters: ${err.message}` };
  }
  state = filters;
  return { ok: true, filters };
}

module.exports = { list, setFilters, cleanFilter, upgrade, DEFAULTS, MAX_FILTERS };
