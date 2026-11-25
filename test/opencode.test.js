'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// OpenCode's state folder, for the stand-in service below to be found in.
process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-opencode-'));
const opencode = require('../lib/opencode');
const { isSessionId } = require('../lib/session-id');

const A = 'ses_deb15829affe6HItxXY7Sc1fxV';
const B = 'ses_deb17d8bbffePcNuwToqLjfeLy';

test('which processes are OpenCode windows, and the session one was started on', () => {
  assert.equal(opencode.isSessionWindow('opencode.exe', []), true);
  assert.equal(opencode.isSessionWindow('opencode', ['mini']), true, 'its minimal interface is a window too');
  assert.equal(opencode.isSessionWindow('opencode.exe', ['C:\\work\\app']), true, 'started in a folder');
  assert.equal(opencode.isSessionWindow('opencode.exe', ['serve', '--service']), false, 'the background service');
  assert.equal(opencode.isSessionWindow('opencode', ['run', 'hello']), false);
  assert.equal(opencode.isSessionWindow('opencode-helper.exe', []), false);
  assert.equal(opencode.sessionArg(['--session', A]), A);
  assert.equal(opencode.sessionArg([`--session=${A}`]), A);
  assert.equal(opencode.sessionArg(['-s', 'ses_x; rm -rf ~']), null, 'only an ID that could be one');
});

test('a window is matched by the session it was started on, else by its title', () => {
  const sessions = [
    { id: A, title: 'Git status check' },
    { id: B, title: 'Next project' },
    { id: 'ses_ccccccccccccccc', title: 'Same name' },
    { id: 'ses_ddddddddddddddd', title: 'Same name' },
  ];
  const titles = { 1: 'OC | Git status check', 2: 'pwsh', 3: 'OC | Same name' };
  const byId = opencode.matchWindows(sessions, [{ pid: 1 }, { pid: 2, session: B }, { pid: 3 }], (pid) => titles[pid]);
  assert.equal(byId.get(A).pid, 1, "by the tab's title");
  assert.equal(byId.get(B).pid, 2, 'by --session, whatever the title');
  assert.equal(byId.has('ses_ccccccccccccccc'), false, 'two sessions with one title: neither is guessed');
  assert.equal(opencode.titleIn('⠋ OC | Long title that was cut…'), 'Long title that was cut…');
});

test("the latest prompt and reply come from OpenCode's messages, newest first", () => {
  const turn = opencode.lastTurn([
    { type: 'idle', outcome: 'succeeded', time: { created: 5 } },
    { type: 'assistant', time: { created: 3, completed: 4 }, content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'All clean.' }, { type: 'text', text: 'Nothing to commit.' }] },
    { type: 'assistant', time: { created: 2 }, content: [{ type: 'tool', name: 'bash' }] },
    { type: 'user', text: 'Run git status', time: { created: 1 } },
    { type: 'user', text: 'An earlier prompt', time: { created: 0 } },
  ]);
  assert.deepEqual(turn.lastPrompt, { text: 'Run git status', at: 1 });
  assert.deepEqual(turn.lastReply, { text: 'All clean.\nNothing to commit.', at: 4 }, 'its text, not its reasoning');
  assert.equal(turn.prompts, 2);
});

test('needs you while it asks, working while a turn runs, idle otherwise', () => {
  const s = { time: { busy: 10, idle: 20, updated: 30 } };
  assert.deepEqual(opencode.statusOf(s, { asks: [{ id: 'p1', action: 'bash', resources: ['git push'] }] }), {
    status: 'waiting',
    waitingFor: 'Permission to bash: git push',
    since: 'ask:p1',
  });
  assert.equal(opencode.statusOf(s, { asks: [{ id: 'p2', message: 'Allow editing app.js?' }] }).waitingFor, 'Allow editing app.js?');
  assert.equal(opencode.statusOf(s, { forms: [{ id: 'f1', title: 'Which database?' }] }).waitingFor, 'Which database?');
  assert.deepEqual(opencode.statusOf(s, { running: { type: 'running' } }), { status: 'busy', waitingFor: null, detail: null, at: 10 });
  assert.deepEqual(opencode.statusOf(s, {}), { status: 'idle', waitingFor: null, at: 20 });
  assert.equal(opencode.statusOf({ ...s, outcome: 'failed' }, {}).waitingFor, 'Its last turn failed');
});

test("OpenCode's session IDs work wherever session IDs are kept, and nothing else does", () => {
  assert.equal(isSessionId(A), true);
  assert.equal(isSessionId('2e7dca2a-a212-453a-9434-395d4de91f71'), true);
  for (const bad of ['ses_short', 'ses_abcdefghijkl; whoami', '../ses_abcdefghijkl', null]) assert.equal(isSessionId(bad), false, String(bad));
  assert.equal(opencode.command({ resume: A, skipPermissions: true }), `opencode --auto --session ${A}`);
  assert.equal(opencode.command({ resume: 'ses_x && evil' }), 'opencode', "an ID that isn't one isn't run");
});

// A stand-in for OpenCode's background service, answering as its API does,
// to a request with the right password only.
async function standIn() {
  const asked = [];
  const now = Date.now();
  const routes = {
    'GET /api/session/active': { data: { [A]: { type: 'running' } } },
    'GET /api/session': { data: [{ id: B, title: 'Idle, in no window', time: { created: now - 9e5, updated: now - 9e5 }, location: { directory: 'C:\\b' } }] },
    [`GET /api/session/${A}`]: {
      data: { id: A, title: 'Fix the login', model: { id: 'tidepool-alpha-free' }, tokens: { output: 321 }, time: { created: now - 60000, updated: now - 1000, busy: now - 5000 }, location: { directory: 'C:\\work\\app' } },
    },
    [`GET /api/session/${A}/permission`]: { data: [{ id: 'per_1', sessionID: A, action: 'bash', resources: ['npm test'], message: 'Run npm test?' }] },
    [`GET /api/session/${A}/form`]: { data: [] },
    [`GET /api/session/${A}/message`]: { data: [{ type: 'user', text: 'Fix the login', time: { created: now - 60000 } }] },
    [`POST /api/session/${A}/interrupt`]: {},
    [`POST /api/session/${A}/prompt`]: { data: {} },
  };
  const password = 'stand-in-password';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const route = `${req.method} ${req.url.split('?')[0]}`;
      asked.push({ route, body });
      const ok = req.headers.authorization === `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
      const answer = routes[route];
      res.writeHead(!ok ? 401 : answer ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok && answer ? answer : { error: 'no' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = path.join(process.env.XDG_STATE_HOME, 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'service.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, password, pid: process.pid }));
  return { server, asked };
}

test("a working session and its question come from OpenCode's service", async () => {
  const s = await standIn();
  try {
    let card;
    for (let i = 0; i < 60 && !card; i++) {
      card = opencode.snapshot().agents.find((a) => a.id === A);
      if (!card) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(card, 'a running session has a card, window or not');
    assert.deepEqual(
      [card.app, card.name, card.cwd, card.status, card.waitingFor, card.model, card.outputTokens, card.lastPrompt.text],
      ['opencode', 'Fix the login', 'C:\\work\\app', 'waiting', 'Run npm test?', 'tidepool-alpha-free', 321, 'Fix the login'],
    );
    assert.ok(!opencode.snapshot().agents.some((a) => a.id === B), 'an idle session in no window has none');
    assert.deepEqual(await opencode.interrupt(A), { ok: true });
    assert.deepEqual(await opencode.queuePrompt(A, 'Where do things stand?'), { ok: true });
    assert.deepEqual(JSON.parse(s.asked.find((a) => a.route === `POST /api/session/${A}/prompt`).body), { text: 'Where do things stand?', delivery: 'queue' });
  } finally {
    s.server.close();
  }
});

test("nothing shows, and nothing is sent, if OpenCode's service is elsewhere", () => {
  const file = path.join(process.env.XDG_STATE_HOME, 'opencode', 'service.json');
  fs.writeFileSync(file, JSON.stringify({ url: 'http://example.com:4096', password: 'x' }));
  return opencode.interrupt(A).then((r) => {
    assert.equal(r.ok, false, 'its password only goes to a service on this computer');
  });
});
