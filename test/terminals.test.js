'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const unix = require('../lib/terminals/unix');
const { create } = require('../lib/terminals/unix-driver');

test('a new tab runs the command in its folder, then stays at a shell', () => {
  assert.equal(unix.shQuote("it's"), `'it'\\''s'`);
  const line = unix.shellLine("/home/a/it's here", 'claude --session-id x');
  assert.equal(line, `cd '/home/a/it'\\''s here' && claude --session-id x; exec "\${SHELL:-/bin/sh}" -l`);
  assert.equal(unix.titleKey('✳ Fix the build'), 'Fix the build');
});

test("sessions opened from inside a Claude session don't inherit its variables", () => {
  const { forgetParentSession } = require('../lib/terminals');
  const env = forgetParentSession({
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    CLAUDE_PID: '42',
    CLAUDE_CONFIG_DIR: '/home/a/.claude',
    CLAUDEX: 'not a Claude Code variable',
    ANTHROPIC_BASE_URL: 'https://example.invalid',
    PATH: '/usr/bin',
  });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_BASE_URL', 'CLAUDEX', 'CLAUDE_CONFIG_DIR', 'PATH']);
});

// A session (pid 30) in a shell (20) in a terminal (10), with no tmux.
const TABLE = new Map([
  [1, { pid: 1, ppid: 0, tty: null, name: 'init' }],
  [10, { pid: 10, ppid: 1, tty: null, name: 'fake-term' }],
  [20, { pid: 20, ppid: 10, tty: '/dev/pts/7', name: 'bash' }],
  [30, { pid: 30, ppid: 20, tty: '/dev/pts/7', name: 'node' }],
]);
const NO_TMUX = { findPane: async () => null, titles: async () => new Map() };

function driver(backend, extra = {}) {
  return create({
    name: 'test',
    backends: [backend],
    openFolder: () => {},
    pickFolder: async () => ({ ok: true, cancelled: true }),
    defaultTerminal: async () => backend.id,
    processTable: async () => TABLE,
    environment: () => ({}),
    tmux: NO_TMUX,
    ...extra,
  });
}

function fakeTerminal(overrides = {}) {
  const calls = [];
  return {
    calls,
    id: 'fake',
    name: 'Fake Terminal',
    available: () => true,
    hosts: (ctx) => ctx.chain.some((p) => p.name === 'fake-term'),
    open: async (dir, command) => (calls.push(['open', dir, command]), { ok: true }),
    focus: async (ctx) => (calls.push(['focus', ctx.tty]), { ok: true, tab: true }),
    type: async (ctx, text) => (calls.push(['type', ctx.tty, text]), null),
    titles: async (ctxs) => new Map(ctxs.map((c) => [c.tty, '✳ Fix the build'])),
    ...overrides,
  };
}

const statusFile = (status) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-status-')), '30.json');
  fs.writeFileSync(file, JSON.stringify({ status }));
  return file;
};

test("Go to window and Catch up go to the session's own terminal", async () => {
  const term = fakeTerminal();
  const d = driver(term);
  assert.deepEqual(await d.focus(30), { ok: true, tab: true, terminal: 'Fake Terminal', sent: false });
  const sent = await d.focus(30, { send: 'Catch me up', statusFile: statusFile('idle') });
  assert.equal(sent.ok, true);
  assert.deepEqual(term.calls.at(-1), ['type', '/dev/pts/7', 'Catch me up']);
});

test("nothing is typed while the session waits on a prompt, or into a terminal that can't take it", async () => {
  const term = fakeTerminal();
  const waiting = await driver(term).focus(30, { send: 'Catch me up', statusFile: statusFile('waiting') });
  assert.equal(waiting.ok, false);
  assert.ok(!term.calls.some((c) => c[0] === 'type'));

  const untypable = await driver(fakeTerminal({ type: undefined })).focus(30, { send: 'x', statusFile: statusFile('idle') });
  assert.match(untypable.error, /tmux/);
});

test('in tmux, tmux types, and the terminal showing tmux comes forward', async () => {
  const term = fakeTerminal();
  const typed = [];
  const tmux = {
    findPane: async (tty) => (tty === '/dev/pts/7' ? { pane_id: '%3' } : null),
    select: async () => ({ tty: '/dev/pts/2', pid: 20 }),
    type: async (pane, text) => (typed.push([pane.pane_id, text]), null),
    titles: async () => new Map(),
  };
  const result = await driver(term, { tmux }).focus(30, { send: 'Catch me up', statusFile: statusFile('idle') });
  assert.equal(result.ok, true);
  assert.deepEqual(typed, [['%3', 'Catch me up']]);
  assert.deepEqual(term.calls, [['focus', '/dev/pts/7']], 'the outer terminal, found through the tmux client');
});

test("a terminal started from another one is the session's terminal, not the outer one", async () => {
  // kitty (11), opened from a shell in the fake terminal (10), runs the session (30).
  const table = new Map([
    [1, { pid: 1, ppid: 0, tty: null, name: 'init' }],
    [10, { pid: 10, ppid: 1, tty: null, name: 'fake-term' }],
    [11, { pid: 11, ppid: 10, tty: null, name: 'kitty' }],
    [20, { pid: 20, ppid: 11, tty: '/dev/pts/8', name: 'bash' }],
    [30, { pid: 30, ppid: 20, tty: '/dev/pts/8', name: 'node' }],
  ]);
  const outer = fakeTerminal({ processNames: ['fake-term'] });
  const inner = fakeTerminal({ id: 'kitty', name: 'kitty', processNames: ['kitty'], hosts: () => false });
  const d = create({
    name: 'test',
    backends: [outer, inner],
    openFolder: () => {},
    pickFolder: async () => ({ ok: true }),
    defaultTerminal: async () => 'fake',
    processTable: async () => table,
    environment: () => ({ OUTER_TERMINAL_VAR: 'inherited' }),
    tmux: NO_TMUX,
  });
  assert.equal((await d.focus(30)).terminal, 'kitty');
  assert.deepEqual(outer.calls, []);
});

test('new sessions open in the chosen terminal, or the default when it is missing', async () => {
  const term = fakeTerminal();
  const d = driver(term);
  await d.open('/work/acme/api', 'claude', { terminal: 'nonexistent' });
  assert.deepEqual(term.calls, [['open', '/work/acme/api', 'claude']]);
  assert.deepEqual(d.terminals(), [{ id: 'fake', name: 'Fake Terminal', available: true }]);
});

test('tab titles are read in the background, without the spinner glyph', async () => {
  const d = driver(fakeTerminal());
  d.refreshTitles([30]);
  for (let i = 0; i < 50 && !d.titleFor(30); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(d.titleFor(30), 'Fix the build');
});
