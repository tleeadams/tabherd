'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TABHERD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-test-'));
const history = require('../lib/history');

const session = (id, prompts) => ({ id, pid: 10, kind: 'interactive', cwd: os.tmpdir(), name: `s-${prompts}`, prompts, startedAt: 1000 });
const USED = '55555555-5555-4555-8555-555555555555';
const UNUSED = '66666666-6666-4666-8666-666666666666';

test('closed sessions are kept, except those never asked anything', () => {
  history.observe([session(USED, 3), session(UNUSED, 0)], 2000);
  history.observe([], 3000);
  const ids = history.list().map((s) => s.id);
  assert.ok(ids.includes(USED), 'a session with prompts can be resumed');
  assert.ok(!ids.includes(UNUSED), "one with none can't, as Claude saved no conversation");
  assert.equal(history.find(USED).closedAt, 2000, 'closed when it was last seen running');
});

test('a resumed session leaves the list while it runs', () => {
  history.observe([session(USED, 4)], 4000);
  assert.ok(!history.list().some((s) => s.id === USED));
  history.observe([], 5000);
  assert.ok(history.list().some((s) => s.id === USED));
});

test('a closed Codex session is kept as Codex, so Resume runs Codex', () => {
  const id = '01900000-0000-7000-8000-0000000000c0';
  history.observe([{ ...session(id, 2), app: 'codex', title: 'Explain the project' }], 6000);
  history.observe([], 7000);
  const s = history.find(id);
  assert.equal(s.app, 'codex');
  assert.equal(s.title, 'Explain the project');
  assert.equal(history.find(USED).app, 'claude', 'Claude sessions say so too');
});

test("a closed OpenCode session is still there after a restart, with its ses_ ID", () => {
  const id = 'ses_deb15829affe6HItxXY7Sc1fxV';
  history.observe([{ ...session(id, 2), app: 'opencode', title: 'Git status check' }], 6500);
  history.observe([], 6600);
  delete require.cache[require.resolve('../lib/history')];
  const again = require('../lib/history');
  assert.equal(again.find(id)?.app, 'opencode', 'kept, so Resume runs OpenCode on it');
});

test('a background run is kept as one, to list or hide in History', () => {
  const id = '01900000-0000-7000-8000-0000000000d0';
  history.observe([{ ...session(id, 1), background: true, name: 'PR review api#12' }], 8000);
  history.observe([], 9000);
  assert.equal(history.find(id).background, true);
  assert.equal(history.find(USED).background, false);
});

test('Save and close keeps one set of sessions to resume, and only what resuming needs', () => {
  const saved = require('../lib/saved');
  const a = '01900000-0000-7000-8000-0000000000e1';
  const set = saved.save(
    [
      { app: 'claude', id: a, cwd: os.tmpdir(), name: 'Fix the build', pid: 42, status: 'idle', claudeDir: os.homedir() },
      { app: 'codex', id: 'not-an-id', cwd: os.tmpdir() },
      { app: 'comfy', id: a, cwd: os.tmpdir() },
    ],
    1234,
  );
  assert.deepEqual(set, { savedAt: 1234, sessions: [{ app: 'claude', id: a, cwd: os.tmpdir(), name: 'Fix the build', claudeDir: os.homedir() }] });
  assert.deepEqual(saved.get(), set);
  assert.equal(saved.save([], 5678).sessions.length, 0, 'the next save replaces it');
});

test('a failed job cleared from the dashboard stays cleared', () => {
  const dismissed = require('../lib/dismissed');
  assert.equal(dismissed.has('comfy:inst-1:bad'), false);
  dismissed.add('comfy:inst-1:bad');
  assert.equal(dismissed.has('comfy:inst-1:bad'), true);
  const file = JSON.parse(fs.readFileSync(path.join(process.env.TABHERD_DATA_DIR, 'dismissed.json'), 'utf8'));
  assert.deepEqual(file.ids.map((x) => x.id), ['comfy:inst-1:bad']);
});
