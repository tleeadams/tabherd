'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TABHERD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-test-'));
const groups = require('../lib/groups');

const root = path.join(os.tmpdir(), 'tabherd-groups');
const WORK = '11111111-1111-4111-8111-111111111111';
const API = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const TODO = '44444444-4444-4444-8444-444444444444';

test('a session is in the group with the nearest folder that holds it', () => {
  const r = groups.setGroups([
    { id: WORK, name: 'Work', color: 'teal', folders: [path.join(root, 'work')] },
    { id: API, name: 'API', color: 'rose', folders: [path.join(root, 'work', 'api')] },
  ]);
  assert.ok(r.ok, r.error);
  const at = (...p) => groups.groupOf({ id: SESSION, cwd: path.join(root, ...p) });
  assert.deepEqual(at('work', 'site'), { group: WORK, placed: false });
  assert.deepEqual(at('work', 'api', 'src'), { group: API, placed: false }, 'the nearer folder wins');
  assert.deepEqual(at('work'), { group: WORK, placed: false }, 'the folder itself counts');
  assert.deepEqual(at('workshop'), { group: null, placed: false }, 'a name that only starts the same is outside');
  assert.deepEqual(groups.groupOf({ id: SESSION, cwd: null }), { group: null, placed: false });
  if (process.platform === 'win32') assert.equal(groups.groupOf({ id: SESSION, cwd: path.join(root, 'WORK', 'site') }).group, WORK, 'in any case on Windows');
});

test('one put in a group, or in none, by hand stays there until it follows its folder again', () => {
  const cwd = path.join(root, 'work', 'site');
  assert.ok(groups.place(SESSION, API).ok);
  assert.deepEqual(groups.groupOf({ id: SESSION, cwd }), { group: API, placed: true });
  assert.ok(groups.place(SESSION, null).ok);
  assert.deepEqual(groups.groupOf({ id: SESSION, cwd }), { group: null, placed: true });
  assert.ok(groups.place(SESSION, 'auto').ok);
  assert.deepEqual(groups.groupOf({ id: SESSION, cwd }), { group: WORK, placed: false });
  assert.ok(!groups.place(SESSION, '99999999-9999-4999-8999-999999999999').ok, 'not a group that exists');
  assert.ok(!groups.place('not-an-id', null).ok);
});

test("a to-do's session starts in the group the to-do was put in", () => {
  const started = '55555555-5555-4555-8555-555555555555';
  groups.place(TODO, API);
  groups.carry(TODO, started);
  assert.deepEqual(groups.groupOf({ id: started, cwd: os.homedir() }), { group: API, placed: true });
});

test("removing a group sends what was put in it back to following its folder", () => {
  groups.place(SESSION, API);
  assert.ok(groups.setGroups(groups.list().filter((g) => g.id !== API)).ok);
  assert.deepEqual(groups.groupOf({ id: SESSION, cwd: path.join(root, 'work', 'api') }), { group: WORK, placed: false });
});

test("groups are checked before they're saved, and saved to disk", () => {
  const one = (g) => groups.setGroups([{ id: WORK, name: 'Work', color: 'teal', folders: [], ...g }]);
  assert.match(one({ name: '  ' }).error, /needs a name/);
  assert.match(one({ color: 'chartreuse' }).error, /colours/);
  assert.match(one({ folders: ['relative/path'] }).error, /full path/);
  assert.match(groups.setGroups([{ name: 'A', color: 'teal' }, { name: 'a', color: 'rose' }]).error, /already a group/);
  const home = one({ name: '  Home   stuff ', folders: ['~', '~'] });
  assert.ok(home.ok, home.error);
  assert.deepEqual(home.groups, [{ id: WORK, name: 'Home stuff', color: 'teal', folders: [os.homedir()] }], 'tidied, ~ expanded, no repeats');
  const file = JSON.parse(fs.readFileSync(path.join(process.env.TABHERD_DATA_DIR, 'groups.json'), 'utf8'));
  assert.deepEqual(file.groups, home.groups);
});
