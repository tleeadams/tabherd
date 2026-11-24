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
