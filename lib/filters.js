'use strict';

const crypto = require('crypto');
const store = require('./store');

// The filter tabs across the top of the dashboard, after All, which is always
// there. Each shows the cards that match everything it names: their status,
// their app, their group, and words in their name or folder. A list left empty
// matches any. To-do cards show only under the filters that ask for them.
// Until they're changed, the tabs are the four the dashboard always had.

const STATUSES = ['needs', 'working', 'idle'];
const APPS = ['claude', 'codex', 'copilot', 'comfy', 'localai', 'ollama', 'lmstudio', 'llamacpp'];
const MAX_FILTERS = 12;
const MAX_GROUPS = 20;
const NAME_MAX = 24;
const TEXT_MAX = 100;
const ID = /^[A-Za-z0-9_-]{1,40}$/;

const DEFAULTS = [
  { id: 'todo', name: 'Todo', statuses: ['needs', 'idle'], apps: [], groups: [], todos: true, text: '' },
  { id: 'needs', name: 'Needs you', statuses: ['needs'], apps: [], groups: [], todos: false, text: '' },
  { id: 'working', name: 'Working', statuses: ['working'], apps: [], groups: [], todos: false, text: '' },
  { id: 'idle', name: 'Idle', statuses: ['idle'], apps: [], groups: [], todos: false, text: '' },
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
      todos: f.todos === true,
      text,
    },
  };
}

function load() {
  const saved = store.read('filters', null);
  if (!Array.isArray(saved?.filters)) return DEFAULTS;
  const filters = [];
  for (const f of saved.filters) {
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
    store.write('filters', { filters });
  } catch (err) {
    return { ok: false, error: `Couldn't save the filters: ${err.message}` };
  }
  state = filters;
  return { ok: true, filters };
}

module.exports = { list, setFilters, cleanFilter, DEFAULTS, MAX_FILTERS };
