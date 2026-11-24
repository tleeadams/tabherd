'use strict';

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

// Groups of sessions, each with a name and a colour. A session joins a group
// by its folder: the group with a folder that holds it, the nearest one if
// several do. A session put in a group (or in none) by hand stays there,
// kept by its session ID, so it's still there when it's resumed. A to-do put
// in one by hand passes that on to the session it starts.

// Named, not free colours: each is tuned for light and dark, and kept apart
// from the status colours, in the page's stylesheet.
const COLORS = ['rose', 'orange', 'olive', 'teal', 'indigo', 'plum', 'brown', 'slate'];
const MAX_GROUPS = 20;
const MAX_FOLDERS = 50;
const MAX_PLACED = 2000;
const NAME_MAX = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASELESS = process.platform === 'win32' || process.platform === 'darwin';

const key = (p) => (CASELESS ? p.toLowerCase() : p);

// A full path, with ~ for the home folder. Nothing has to be there yet.
function cleanFolder(p) {
  if (typeof p !== 'string' || p.length > 1000) return null;
  const t = p.trim().replace(/^~(?=$|[\\/])/, os.homedir());
  return t && path.isAbsolute(t) ? path.resolve(t) : null;
}

// A group as given, cleaned, or a reason it can't be saved.
function cleanGroup(g) {
  if (!g || typeof g !== 'object') return { error: 'Not a group.' };
  const name = typeof g.name === 'string' ? g.name.replace(/\s+/g, ' ').trim() : '';
  if (!name) return { error: 'A group needs a name.' };
  if (name.length > NAME_MAX) return { error: `Keep group names to ${NAME_MAX} characters.` };
  if (!COLORS.includes(g.color)) return { error: `Not one of the group colours: ${g.color}` };
  const given = Array.isArray(g.folders) ? g.folders : [];
  if (given.length > MAX_FOLDERS) return { error: `A group can have up to ${MAX_FOLDERS} folders.` };
  const folders = [];
  for (const f of given) {
    const clean = cleanFolder(f);
    if (!clean) return { error: `"${f}" isn't a full path. Start it with a drive or /, or ~ for your home folder.` };
    if (!folders.some((x) => key(x) === key(clean))) folders.push(clean);
  }
  const id = typeof g.id === 'string' && UUID.test(g.id) ? g.id : crypto.randomUUID();
  return { group: { id, name, color: g.color, folders } };
}

function load() {
  const saved = store.read('groups', null);
  const groups = [];
  for (const g of Array.isArray(saved?.groups) ? saved.groups : []) {
    const { group } = cleanGroup(g);
    if (group && groups.length < MAX_GROUPS && !groups.some((x) => x.id === group.id)) groups.push(group);
  }
  const placed = new Map();
  for (const [id, p] of Object.entries(saved?.placed || {})) {
    if (!UUID.test(id) || !p || typeof p !== 'object') continue;
    if (p.group !== null && !groups.some((g) => g.id === p.group)) continue;
    placed.set(id, { group: p.group, at: Number(p.at) || 0 });
  }
  return { groups, placed };
}

let state = load();

function save(next) {
  const placed = [...next.placed].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_PLACED);
  try {
    store.write('groups', { groups: next.groups, placed: Object.fromEntries(placed) });
  } catch (err) {
    return { ok: false, error: `Couldn't save the groups: ${err.message}` };
  }
  state = { groups: next.groups, placed: new Map(placed) };
  return { ok: true, groups: state.groups };
}

const list = () => state.groups;

// Replaces every group, as the Settings editor saves them. A session put by
// hand into a group that's gone goes back to following its folder.
function setGroups(given) {
  if (!Array.isArray(given)) return { ok: false, error: 'Expected a list of groups.' };
  if (given.length > MAX_GROUPS) return { ok: false, error: `Up to ${MAX_GROUPS} groups.` };
  const groups = [];
  for (const g of given) {
    const { group, error } = cleanGroup(g);
    if (error) return { ok: false, error };
    if (groups.some((x) => x.id === group.id)) return { ok: false, error: 'Two groups have the same ID.' };
    if (groups.some((x) => x.name.toLowerCase() === group.name.toLowerCase())) return { ok: false, error: `There's already a group called ${group.name}.` };
    groups.push(group);
  }
  const placed = new Map([...state.placed].filter(([, p]) => p.group === null || groups.some((g) => g.id === p.group)));
  return save({ groups, placed });
}

// Puts a session or to-do in a group by hand (`group` is its ID), in none
// (null), or back to following its folder ('auto').
function place(id, group) {
  if (typeof id !== 'string' || !UUID.test(id)) return { ok: false, error: 'Not a session.' };
  if (group !== null && group !== 'auto' && !state.groups.some((g) => g.id === group)) return { ok: false, error: 'That group no longer exists.' };
  const placed = new Map(state.placed);
  if (group === 'auto') placed.delete(id);
  else placed.set(id, { group, at: Date.now() });
  return save({ groups: state.groups, placed });
}

// A to-do's session starts in the group the to-do was put in by hand.
function carry(fromId, toId) {
  const p = state.placed.get(fromId);
  return p ? place(toId, p.group) : { ok: true };
}

function inside(dir, folder) {
  const d = key(path.resolve(dir));
  const f = key(folder);
  return d === f || d.startsWith(f.endsWith(path.sep) ? f : f + path.sep);
}

// The group a session or to-do is in: { group: its ID or null, placed: true
// if it was put there by hand }.
function groupOf({ id, cwd }) {
  const p = state.placed.get(id);
  if (p) return { group: p.group, placed: true };
  let best = null;
  let bestLength = -1;
  if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
    for (const g of state.groups) {
      for (const f of g.folders) {
        if (f.length > bestLength && inside(cwd, f)) {
          best = g.id;
          bestLength = f.length;
        }
      }
    }
  }
  return { group: best, placed: false };
}

module.exports = { list, setGroups, place, carry, groupOf, COLORS };
