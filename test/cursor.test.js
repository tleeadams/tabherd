'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Cursor's folders, for the chats and transcripts written below.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-cursor-'));
process.env.CURSOR_CONFIG_DIR = path.join(home, 'config');
process.env.CURSOR_DATA_DIR = path.join(home, 'data');
const cursor = require('../lib/cursor');

const A = '12e01b21-4893-47f2-82ed-1d244466aaa8';
const B = 'a50678f9-4e04-4f02-971f-908b79877850';
const C = '0d9c4e57-6a1b-4f3e-9c2d-7b8a9e0f1a2b';
const D = '5f6e7d8c-9b0a-4c1d-8e2f-3a4b5c6d7e8f';
const WIN = 'C:\\Users\\someone\\AppData\\Local\\cursor-agent\\versions\\2026.11.22-e9042b2';

test('which processes are Cursor windows, and what they were started on', () => {
  assert.deepEqual(cursor.windowFrom(`"${WIN}\\node.exe" ${WIN}\\index.js`), { version: '2026.11.22-e9042b2', resume: null, model: null });
  assert.equal(cursor.windowFrom(`"${WIN}\\node.exe" ${WIN}\\index.js --resume ${A}`).resume, A);
  assert.equal(cursor.windowFrom(`"${WIN}\\node.exe" "${WIN}\\index.js" --resume=${A} --model gpt-5`).model, 'gpt-5');
  assert.equal(cursor.windowFrom(`"${WIN}\\node.exe" ${WIN}\\index.js --resume ${A};calc`).resume, null, 'only an ID that could be one');
  assert.equal(cursor.windowFrom(`${WIN}\\node.exe ${WIN}\\index.js worker-server`), null, 'the helper each window starts');
  assert.equal(cursor.windowFrom(`"${WIN}\\node.exe" ${WIN}\\index.js -p "Say hello"`), null, 'a run with no window');
  assert.equal(cursor.windowFrom(`"${WIN}\\node.exe" ${WIN}\\index.js status`), null);
  assert.ok(cursor.windowFrom('/home/someone/.local/share/cursor-agent/versions/2026.11.22-e9042b2/node /home/someone/.local/share/cursor-agent/versions/2026.11.22-e9042b2/index.js ls'), 'picking a chat to resume');
  assert.ok(cursor.windowFrom('"C:\\Users\\Some One\\AppData\\Local\\cursor-agent\\versions\\2026.11.22-e9042b2\\node.exe" "C:\\Users\\Some One\\AppData\\Local\\cursor-agent\\versions\\2026.11.22-e9042b2\\index.js"'), 'a home folder with a space in it');
  assert.equal(cursor.windowFrom('"C:\\Program Files\\nodejs\\node.exe" server.js'), null);
  assert.equal(cursor.elapsed('05:23'), 323000);
  assert.equal(cursor.elapsed('1-02:03:04'), ((26 * 60 + 3) * 60 + 4) * 1000);
});

test("a tab's title gives the chat's title and, with the status indicators on, its state", () => {
  assert.deepEqual(cursor.readTitle('Get Version Info - ✅ Ready'), { name: 'Get Version Info', state: 'Ready' });
  assert.deepEqual(cursor.readTitle('Get Version Info - ⏳ Working ..·'), { name: 'Get Version Info', state: 'Working' });
  assert.deepEqual(cursor.readTitle('Cursor Agent - ⌨️ Running shell command'), { name: '', state: 'Running shell command' });
  assert.deepEqual(cursor.readTitle('Fix the login (wt-1) - 🔐 Waiting for confirmation'), { name: 'Fix the login (wt-1)', state: 'Waiting for confirmation' });
  assert.deepEqual(cursor.readTitle('Get Version Info'), { name: 'Get Version Info', state: null }, 'status indicators off');
  assert.deepEqual(cursor.readTitle('Cursor Agent'), { name: '', state: null }, 'no title yet');
  assert.deepEqual(cursor.readTitle(null), { name: '', state: null });
});

test("a window goes with the chat it was started on, else its title's, else the newest begun in it", () => {
  const chats = [
    { id: A, title: 'Get Version Info', createdAt: 1000 },
    { id: B, title: 'Next project', createdAt: 2000 },
    { id: C, title: null, createdAt: 50000 },
    { id: D, title: null, createdAt: 60000 },
    { id: 'e0000000-0000-4000-8000-000000000001', title: 'Same name', createdAt: 3000 },
    { id: 'e0000000-0000-4000-8000-000000000002', title: 'Same name', createdAt: 4000 },
  ];
  const titles = { 1: 'Get Version Info - ✅ Ready', 2: 'pwsh', 3: 'Cursor Agent', 4: 'Cursor Agent - ✅ Ready', 5: 'Same name', 6: 'Fix (wt-2)' };
  const wins = [
    { pid: 1, startedAt: 500 },
    { pid: 2, startedAt: 1500, resume: B },
    { pid: 3, startedAt: 49500 },
    { pid: 4, startedAt: 59000 },
    { pid: 5, startedAt: 10000 },
  ];
  const byPid = cursor.matchWindows(chats, wins, (pid) => titles[pid]);
  assert.equal(byPid.get(1).id, A, "by the tab's title");
  assert.equal(byPid.get(2).id, B, 'by --resume, whatever the title');
  assert.equal(byPid.get(4).id, D, 'the chat begun since it started');
  assert.equal(byPid.get(3).id, C, 'and an earlier window, the one begun before that');
  assert.equal(byPid.has(5), false, 'two chats with one title, and none begun since: neither is guessed');
  const worktree = cursor.matchWindows([{ id: A, title: 'Fix', createdAt: 1 }], [{ pid: 6 }], (pid) => titles[pid]);
  assert.equal(worktree.get(6).id, A, 'a title with its worktree after it');
});

const line = (o) => `${JSON.stringify(o)}\n`;
const user = (text, stamp = 'Tuesday, Nov 25, 2025, 7:47 PM (UTC-5)') =>
  line({ role: 'user', message: { content: [{ type: 'text', text: `<timestamp>${stamp}</timestamp>\n<user_query>\n${text}\n</user_query>` }] } });
const assistant = (...content) => line({ role: 'assistant', message: { content } });

function transcript(cwd, id, text) {
  const dir = path.join(cursor.PROJECTS_DIR, cursor.folderName(cwd), 'agent-transcripts', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), text);
  return path.join(dir, `${id}.jsonl`);
}

function chat(id, meta) {
  const dir = path.join(cursor.CHATS_DIR, 'c08f0f779a6f534e60c667812649813b', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 1, ...meta }));
}

test('a transcript gives the prompts, the latest reply, and whether a turn is running', () => {
  const file = transcript('C:\\work\\app', A, user('run git --version and tell me the version') + assistant({ type: 'text', text: "I'll run it." }, { type: 'tool_use', name: 'Shell', input: { command: 'git --version' } }));
  const log = new cursor.CursorLog(file);
  assert.ok(log.update());
  let s = log.summary();
  assert.deepEqual(s.lastPrompt, { text: 'run git --version and tell me the version', at: Date.UTC(2025, 10, 26, 0, 47) }, 'without the <timestamp> Cursor adds');
  assert.equal(s.turnOpen, true);
  assert.deepEqual(s.tools, [{ name: 'Shell', detail: 'git --version', at: null }]);
  assert.equal(s.contextTokens, 0, 'Cursor records no context use');
  fs.appendFileSync(file, assistant({ type: 'text', text: '**git version 2.56.0**' }) + line({ type: 'turn_ended', status: 'success' }));
  log.update();
  s = log.summary();
  assert.equal(s.lastReply.text, '**git version 2.56.0**');
  assert.ok(s.lastReply.at >= s.lastPrompt.at, 'a reply is newer than its prompt');
  assert.equal(s.turnOpen, false);
  assert.deepEqual(s.tools, []);
  fs.appendFileSync(file, user('and the node version?', 'Tuesday, Nov 25, 2025, 12:05 AM (UTC+5:30)') + line({ type: 'turn_ended', status: 'error', error: 'network' }));
  log.update();
  s = log.summary();
  assert.equal(s.prompts, 2);
  assert.equal(s.lastPrompt.at, Date.UTC(2025, 10, 24, 18, 35));
  assert.equal(s.lastTurn, 'error');
});

test("its state comes from the tab's title, else from the transcript", () => {
  const asking = { tools: [{ name: 'Shell', detail: 'git push' }], turnOpen: true };
  assert.deepEqual(cursor.stateOf('Waiting for confirmation', asking), { status: 'waiting', waitingFor: 'Approval: run git push' });
  assert.deepEqual(cursor.stateOf('Waiting for you', {}), { status: 'waiting', waitingFor: 'Your answer' });
  assert.deepEqual(cursor.stateOf('Running shell command', asking), { status: 'busy', waitingFor: null });
  assert.deepEqual(cursor.stateOf('Ready', { turnOpen: true }), { status: 'idle', waitingFor: null }, 'the title is newer than the transcript');
  assert.deepEqual(cursor.stateOf(null, asking), { status: 'busy', waitingFor: null }, 'a turn with no end yet');
  assert.deepEqual(cursor.stateOf(null, { lastTurn: 'error' }), { status: 'waiting', waitingFor: 'Its last turn failed' });
  assert.deepEqual(cursor.stateOf(null, null), { status: 'idle', waitingFor: null }, 'no prompt yet');
});

test("an open window's chat becomes a card, and chats with prompts are found for the history", async () => {
  const cwd = path.join(home, 'work', 'site');
  chat(C, { createdAtMs: 1795654011793, updatedAtMs: Date.now(), hasConversation: true, title: 'Tidy the CSS', cwd });
  chat(D, { createdAtMs: 1795654011793, updatedAtMs: Date.now(), hasConversation: false, cwd });
  transcript(cwd, C, user('tidy the CSS') + assistant({ type: 'text', text: 'Done.' }) + line({ type: 'turn_ended', status: 'success' }));
  const chats = [
    { id: C, title: 'Tidy the CSS', cwd, createdAt: 1795654011793 },
    { id: D, title: null, cwd, createdAt: 1795654011793 },
  ];
  const [card] = cursor.agentsFrom(chats, [{ pid: 4242, memBytes: 1e8, startedAt: 1795654010000, version: '2026.11.22-e9042b2', model: null }], {
    titleFor: () => 'Tidy the CSS - ✅ Ready',
  });
  assert.equal(card.app, 'cursor');
  assert.equal(card.id, C);
  assert.equal(card.pid, 4242);
  assert.equal(card.name, 'Tidy the CSS');
  assert.equal(card.cwd, cwd);
  assert.equal(card.status, 'idle');
  assert.equal(card.prompts, 1);
  assert.equal(card.lastReply.text, 'Done.');
  assert.equal(card.version, '2026.11.22-e9042b2');
  const found = await cursor.sessionFiles(0);
  assert.deepEqual(
    found.map((f) => f.id),
    [C],
    'not one with nothing asked yet',
  );
});

test('a new tab runs cursor-agent, resuming a chat if given one', () => {
  assert.equal(cursor.command(), 'cursor-agent');
  assert.equal(cursor.command({ skipPermissions: true, resume: A }), `cursor-agent --force --resume ${A}`);
  assert.equal(cursor.command({ resume: 'x; calc' }), 'cursor-agent', 'only an ID that could be one');
});
