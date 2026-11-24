'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { Rollout, describeCall } = require('../lib/codex-rollout');
const { CodexClient, encodeFrame, decodeFrames, mapStatus } = require('../lib/codex-client');
const { isSessionWindow, matchWindows, titleParts } = require('../lib/codex');

const ID = '01900000-0000-7000-8000-000000000001';
const at = (s) => `2026-01-02T03:04:${String(s).padStart(2, '0')}.000Z`;
const line = (s, type, payload) => JSON.stringify({ timestamp: at(s), type, payload });

function writeRollout(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-codex-')), `rollout-2026-01-02T03-04-00-${ID}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
  return file;
}

test("a Codex session file gives the card's prompt, reply, model, tokens and running tools", () => {
  const file = writeRollout([
    line(0, 'session_meta', { id: ID, timestamp: at(0), cwd: '/home/user/project', originator: 'codex-tui', cli_version: '1.2.3', source: 'cli', git: { branch: 'main' } }),
    line(1, 'event_msg', { type: 'task_started', turn_id: 't1', model_context_window: 200000 }),
    line(1, 'turn_context', { cwd: '/home/user/project', model: 'gpt-test', approval_policy: 'on-request' }),
    line(1, 'world_state', { full: true, state: {} }),
    line(2, 'event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'What does this do?' }] } }),
    line(3, 'event_msg', { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Looking at the README first.' }], phase: 'commentary' } }),
    line(4, 'response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'const r = await tools.exec_command({cmd:"rg --files -g \\"README*\\"", yield_time_ms: 1000});' }),
  ]);
  const r = new Rollout(file);
  assert.ok(r.update());
  let s = r.summary();
  assert.equal(s.prompts, 1);
  assert.equal(s.lastPrompt.text, 'What does this do?');
  assert.equal(s.lastReply.text, 'Looking at the README first.');
  assert.equal(s.model, 'gpt-test');
  assert.equal(s.gitBranch, 'main');
  assert.equal(s.contextLimit, 200000);
  assert.ok(s.turnOpen, 'mid-turn');
  assert.deepEqual(s.tools.map((t) => [t.name, t.detail]), [['Shell', 'rg --files -g "README*"']]);
  assert.deepEqual(r.origin(), { cwd: '/home/user/project', entrypoint: 'codex-tui', originator: 'codex-tui', source: 'cli', parentThreadId: null, startedAt: at(0) });

  // The rest of the turn, read from where the last read stopped.
  fs.appendFileSync(
    file,
    [
      line(5, 'response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: [] }),
      line(6, 'event_msg', { type: 'token_count', info: { total_token_usage: { output_tokens: 321 }, last_token_usage: { total_tokens: 15000 }, model_context_window: 258000 } }),
      line(7, 'event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: 'It is a dashboard.', duration_ms: 7000 }),
    ]
      .map((l) => `${l}\n`)
      .join(''),
  );
  assert.ok(r.update());
  s = r.summary();
  assert.equal(s.tools.length, 0, 'the command finished');
  assert.ok(!s.turnOpen);
  assert.equal(s.lastReply.text, 'It is a dashboard.');
  assert.equal(s.lastTurnMs, 7000);
  assert.equal(s.contextTokens, 15000);
  assert.equal(s.outputTokens, 321);
  assert.equal(s.contextLimit, 258000);
  assert.equal(s.lastEventAt, at(7));
});

test('older Codex files, with user_message and agent_message, read the same', () => {
  const file = writeRollout([
    line(0, 'session_meta', { id: ID, cwd: '/p', originator: 'codex_cli_rs', source: 'cli' }),
    line(1, 'event_msg', { type: 'user_message', message: 'Fix the build' }),
    line(2, 'event_msg', { type: 'agent_message', message: 'Fixed.' }),
    line(3, 'compacted', { message: '' }),
  ]);
  const r = new Rollout(file);
  r.update();
  const s = r.summary();
  assert.equal(s.lastPrompt.text, 'Fix the build');
  assert.equal(s.lastReply.text, 'Fixed.');
  assert.equal(s.compactions, 1);
});

test("a subagent's session file says so", () => {
  const r = new Rollout(writeRollout([line(0, 'session_meta', { id: ID, cwd: '/p', source: { subagent: { thread_spawn: {} } } })]));
  r.update();
  assert.ok(r.origin().parentThreadId);
});

test('tool calls are described by what they do', () => {
  assert.deepEqual(describeCall({ type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/a.js\n*** Add File: b.md\n' }), { name: 'Edit', detail: 'a.js, b.md' });
  assert.deepEqual(describeCall({ type: 'function_call', name: 'wait', arguments: '{"cell_id":"4"}' }), { name: 'Waiting on a command', detail: '' });
  assert.deepEqual(describeCall({ type: 'function_call', name: 'web_search', arguments: '{"query":"node streams"}' }), { name: 'web_search', detail: 'node streams' });
});

test("Codex's status becomes the dashboard's", () => {
  assert.deepEqual(mapStatus({ type: 'active', activeFlags: ['waitingOnApproval'] }), { status: 'waiting', waitingFor: 'Approval' });
  assert.deepEqual(mapStatus({ type: 'active', activeFlags: ['waitingOnUserInput'] }), { status: 'waiting', waitingFor: 'Your answer' });
  assert.deepEqual(mapStatus({ type: 'active', activeFlags: [] }), { status: 'busy', waitingFor: null });
  assert.deepEqual(mapStatus({ type: 'idle' }), { status: 'idle', waitingFor: null });
  assert.equal(mapStatus({ type: 'notLoaded' }), null);
});

test('WebSocket frames of every length survive the trip', () => {
  for (const size of [0, 5, 125, 126, 70000]) {
    const text = 'x'.repeat(size);
    const both = Buffer.concat([encodeFrame(text), encodeFrame('next')]);
    const { frames, rest } = decodeFrames(both.subarray(0, both.length - 1));
    assert.equal(frames.length, 1, 'a partial frame waits for the rest');
    assert.equal(frames[0].data.toString(), text);
    assert.equal(decodeFrames(Buffer.concat([rest, both.subarray(-1)])).frames[0].data.toString(), 'next');
  }
});

// A frame from the service, which isn't masked.
function serverFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([head, payload]);
}

// A stand-in for `codex app-server proxy` and the service behind it.
function fakeService(threads) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => proc.emit('exit', 0);
  proc.received = [];
  proc.push = (obj) => proc.stdout.write(serverFrame(obj));
  let buf = Buffer.alloc(0);
  let upgraded = false;
  proc.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      buf = buf.subarray(end + 4);
      upgraded = true;
      proc.stdout.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    }
    const { frames, rest } = decodeFrames(buf);
    buf = rest;
    for (const f of frames) {
      const m = JSON.parse(f.data.toString());
      proc.received.push(m);
      if (m.method === 'initialize') proc.push({ id: m.id, result: { userAgent: 'test' } });
      if (m.method === 'thread/loaded/list') proc.push({ id: m.id, result: { data: threads.map((t) => t.id), nextCursor: null } });
      if (m.method === 'thread/read') proc.push({ id: m.id, result: { thread: threads.find((t) => t.id === m.params.threadId) } });
    }
  });
  return proc;
}

const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check());
};

test("the client keeps the open sessions' status, and never answers the service's requests", async () => {
  const thread = { id: ID, name: 'Explain the project', cwd: '/p', status: { type: 'idle' }, createdAt: 1, updatedAt: 2 };
  const proc = fakeService([thread]);
  const client = new CodexClient({ home: os.tmpdir(), spawnProxy: () => proc });
  client.connect();
  await until(() => client.ready);
  assert.equal(client.threads.get(ID).name, 'Explain the project');

  proc.push({ method: 'thread/status/changed', params: { threadId: ID, status: { type: 'active', activeFlags: ['waitingOnApproval'] } } });
  // An approval request is for the session's window. Answering could approve it.
  proc.push({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: ID } });
  proc.push({ method: 'thread/name/updated', params: { threadId: ID, threadName: 'Renamed' } });
  await until(() => client.threads.get(ID).name === 'Renamed');
  assert.deepEqual(client.threads.get(ID).status, { type: 'active', activeFlags: ['waitingOnApproval'] });
  assert.ok(!proc.received.some((m) => m.id === 99), 'no reply to the approval request');

  proc.push({ method: 'thread/closed', params: { threadId: ID } });
  await until(() => !client.threads.has(ID));
  client.close();
  assert.ok(!client.ready && client.retryAt > Date.now(), 'tries again later');
});

test('Codex in a terminal is told apart from its service and other commands', () => {
  assert.ok(isSessionWindow('codex-x86_64-pc-windows-msvc.exe', []));
  assert.ok(isSessionWindow('codex', ['resume', ID]));
  assert.ok(isSessionWindow('codex', ['-C', 'some-dir']));
  assert.ok(!isSessionWindow('codex.exe', ['app-server', '--listen', 'unix://']));
  assert.ok(!isSessionWindow('codex', ['exec', 'fix it']));
  assert.ok(!isSessionWindow('codex-code-mode-host.exe', ['--listen', 'grpc+stdio://']));
  assert.ok(!isSessionWindow('node', []));
});

test("each Codex session gets the window whose tab's title names it", () => {
  assert.deepEqual(titleParts('⠋ Fix login | web'), ['Fix login', 'web']);
  const titles = { 1: 'Action Required | Fix login | web', 2: '⠙ Write docs | site', 3: 'api' };
  const titleFor = (pid) => titles[pid];
  const threads = [
    { id: 'a', name: 'Fix login' },
    { id: 'b', name: 'Write docs' },
    { id: 'c', name: null },
  ];
  const byThread = matchWindows(threads, [{ pid: 1 }, { pid: 2 }, { pid: 3 }], titleFor);
  assert.equal(byThread.get('a').pid, 1);
  assert.equal(byThread.get('b').pid, 2);
  assert.equal(byThread.get('c').pid, 3, 'the one unnamed session gets the one window left');
  assert.equal(matchWindows([{ id: 'x', name: null }, { id: 'y', name: null }], [{ pid: 1 }, { pid: 2 }], titleFor).size, 0, 'no guessing');
});

test("tabs opened from inside Codex don't get its session's variables or plain output", () => {
  const { forgetParentSession } = require('../lib/terminals');
  const env = forgetParentSession({
    CODEX_THREAD_ID: 't',
    CODEX_SESSION_ID: 's',
    CODEX_SANDBOX: 'seatbelt',
    CODEX_SANDBOX_NETWORK_DISABLED: '1',
    CODEX_CI: '1',
    CODEX_HOME: '/home/a/.codex',
    CODEX_API_KEY: 'kept',
    NO_COLOR: '1',
    TERM: 'dumb',
    PAGER: 'cat',
    PATH: '/usr/bin',
  });
  assert.deepEqual(env, { CODEX_HOME: '/home/a/.codex', CODEX_API_KEY: 'kept', PATH: '/usr/bin' });
  assert.deepEqual(forgetParentSession({ NO_COLOR: '1', TERM: 'xterm-256color' }), { NO_COLOR: '1', TERM: 'xterm-256color' }, "someone's own NO_COLOR stays");
});
