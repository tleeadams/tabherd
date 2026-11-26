'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TABHERD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-test-'));
const filters = require('../lib/filters');

test('until they are changed, the filters are the four the dashboard always had, and Ticket done', () => {
  assert.deepEqual(
    filters.list().map((f) => f.name),
    ['Todo', 'Needs you', 'Working', 'Idle', 'Ticket done'],
  );
  assert.deepEqual(filters.list()[4].tickets, ['done', 'closed'], 'every ticket done, or cancelled');
  assert.deepEqual(filters.list()[4].statuses, [], 'whatever the session is doing');
  assert.equal(filters.list()[0].todos, true, 'Todo shows the to-dos too');
  assert.deepEqual(filters.list()[2].statuses, ['working', 'shell'], 'Working counts Shell running, as it always has');
});

test('filters saved before Shell running stood apart pick it wherever they picked Working', () => {
  const old = { filters: [{ name: 'Busy', statuses: ['working'] }, { name: 'Waiting', statuses: ['needs'] }, { name: 'Any' }] };
  assert.deepEqual(
    filters.upgrade(old).map((f) => f.statuses),
    [['working', 'shell'], ['needs'], undefined, []],
  );
  const current = { version: 2, filters: [{ name: 'Busy', statuses: ['working'] }] };
  assert.deepEqual(filters.upgrade(current)[0].statuses, ['working'], 'a filter saved since then is left as it is');
});

test('Ticket done is added once to the filters saved before it', () => {
  const names = (saved) => filters.upgrade(saved).map((f) => f.name);
  assert.deepEqual(names({ version: 2, filters: [{ name: 'Mine' }] }), ['Mine', 'Ticket done']);
  assert.deepEqual(names({ version: 2, filters: [{ name: ' ticket DONE ', tickets: ['done'] }] }), [' ticket DONE '], 'not beside one of the same name');
  const full = Array.from({ length: 12 }, (_, i) => ({ name: `F${i}` }));
  assert.equal(names({ version: 2, filters: full }).length, 12, 'not past the most there can be');
  assert.deepEqual(names({ version: 3, filters: [{ name: 'Mine' }] }), ['Mine'], 'deleted since, it stays gone');
});

test('a filter is cleaned as it is saved', () => {
  const r = filters.setFilters([
    { name: '  Work   stuff ', statuses: ['needs', 'busy', 'shell', 'needs'], apps: ['codex', 'emacs'], groups: ['abc', 'none', 7], tickets: ['done', 'merged', 'none', 'done'], todos: 'yes', text: '  api  ' },
  ]);
  assert.ok(r.ok, r.error);
  const [f] = r.filters;
  assert.match(f.id, /^[0-9a-f-]{36}$/, 'a new one gets an ID');
  assert.equal(f.name, 'Work stuff');
  assert.deepEqual(f.statuses, ['needs', 'shell'], 'only the statuses there are, once each');
  assert.deepEqual(f.apps, ['codex']);
  assert.deepEqual(f.groups, ['abc', 'none']);
  assert.deepEqual(f.tickets, ['done', 'none'], 'only the ticket statuses there are, once each');
  assert.equal(f.todos, false, 'to-dos only when asked for with true');
  assert.equal(f.text, 'api');
  assert.deepEqual(filters.list(), r.filters, 'and kept');
});

test('a filter needs a name of its own', () => {
  assert.match(filters.setFilters([{ name: '  ' }]).error, /needs a name/);
  assert.match(filters.setFilters([{ name: 'all' }]).error, /All is already there/);
  assert.match(filters.setFilters([{ name: 'Mine' }, { name: 'MINE' }]).error, /already a filter called/);
  assert.match(filters.setFilters([{ name: 'x'.repeat(25) }]).error, /24 characters/);
  assert.match(filters.setFilters(Array.from({ length: 13 }, (_, i) => ({ name: `F${i}` }))).error, /Up to 12/);
  assert.equal(filters.list()[0].name, 'Work stuff', 'nothing changes when a save is refused');
});

test('every filter can go, leaving only All', () => {
  assert.ok(filters.setFilters([]).ok);
  assert.deepEqual(filters.list(), []);
});
