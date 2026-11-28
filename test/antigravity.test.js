'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const agy = require('../lib/antigravity');

// Protocol buffer fields, as agy writes them: a number, or bytes.
const varint = (n) => {
  const out = [];
  do {
    out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n = Math.floor(n / 128);
  } while (n);
  return Buffer.from(out);
};
const field = (n, value) =>
  typeof value === 'number'
    ? Buffer.concat([varint(n * 8), varint(value)])
    : Buffer.concat([varint(n * 8 + 2), varint(Buffer.byteLength(value)), Buffer.from(value)]);
const msg = (...parts) => Buffer.concat(parts);

const prompt = (text, status = 3) => ({ step_type: agy.STEP.USER_INPUT, status, step_payload: msg(field(5, msg(field(12, 'x'))), field(19, msg(field(2, text)))) });
const reply = (text, calls = [], status = 3) => ({
  step_type: agy.STEP.PLANNER_RESPONSE,
  status,
  step_payload: field(20, msg(field(1, text), ...calls.map(([name, args]) => field(7, msg(field(1, 'call_1'), field(2, name), field(3, JSON.stringify(args))))))),
});
const tool = (status) => ({ step_type: 132, status, step_payload: field(140, msg(field(1, msg(field(1, 'CommandLine'), field(2, 'git status'))))) });

test('protocol buffers are read field by field, and anything else is refused', () => {
  assert.deepEqual(agy.fields(msg(field(1, 150), field(2, 'hi'))), [
    [1, 150],
    [2, Buffer.from('hi')],
  ]);
  assert.equal(agy.fields(Buffer.from('plain text, not a message')), null);
});

test("a conversation's steps give its prompts, latest reply and the tools it's running", () => {
  const s = agy.readSteps([
    prompt('Create a file named hello.txt'),
    reply('Created hello.txt.\n\nClaim: ABC-12', [['write_file', { TargetFile: 'C:\\work\\hello.txt' }]]),
    prompt("What's in hello.txt?"),
    reply('', [['run_command', { CommandLine: 'git status', toolSummary: 'Git status check' }]]),
    tool(agy.STATE.RUNNING),
  ]);
  assert.equal(s.prompts, 2);
  assert.equal(s.firstPrompt.text, 'Create a file named hello.txt');
  assert.equal(s.lastPrompt.text, "What's in hello.txt?");
  assert.equal(s.lastReply.text, 'Created hello.txt. Claim: ABC-12', 'a reply with only tool calls keeps the last one with words');
  assert.deepEqual(s.tools, [{ name: 'run_command', detail: 'Git status check', at: null }], 'its own summary of the tool call');
  assert.deepEqual(s.last, { type: 132, state: agy.STATE.RUNNING });
  assert.deepEqual(s.ticketRefs, [{ op: 'claim', key: 'ABC-12', hint: null }], 'the tickets its replies claim');
});

test('working, needing you and idle come from the run status and the latest step', () => {
  const running = { status: 'CASCADE_RUN_STATUS_RUNNING' };
  const idle = { status: 'CASCADE_RUN_STATUS_IDLE' };
  const steps = (last, tools = []) => ({ last, tools });
  assert.deepEqual(agy.stateOf(running, steps({ type: 132, state: agy.STATE.RUNNING })), { status: 'busy', waitingFor: null });
  assert.deepEqual(agy.stateOf(running, steps({ type: 132, state: agy.STATE.WAITING }, [{ name: 'run_command', detail: 'npm test' }])), {
    status: 'waiting',
    waitingFor: 'Approval: run_command npm test',
  });
  assert.deepEqual(agy.stateOf(running, steps({ type: agy.STEP.ASK_QUESTION, state: agy.STATE.RUNNING })), { status: 'waiting', waitingFor: 'Your answer' });
  assert.deepEqual(agy.stateOf(idle, steps({ type: agy.STEP.ERROR_MESSAGE, state: agy.STATE.DONE })), { status: 'waiting', waitingFor: 'Its last turn failed' });
  assert.deepEqual(agy.stateOf(idle, steps({ type: agy.STEP.PLANNER_RESPONSE, state: agy.STATE.DONE })), { status: 'idle', waitingFor: null });
});

test('only agy in a window counts, not its updater, print runs or other commands', () => {
  assert.equal(agy.isSessionWindow([]), true);
  assert.equal(agy.isSessionWindow(['--conversation', '9518ee7a-48a2-4071-b436-169ba4af21a3']), true);
  assert.equal(agy.isSessionWindow(['--bg-updater', '--app_data_dir=antigravity-cli']), false);
  assert.equal(agy.isSessionWindow(['-p', 'hello']), false);
  assert.equal(agy.isSessionWindow(['--version']), false);
  assert.equal(agy.isSessionWindow(['mcp', 'list']), false);
  assert.equal(agy.resumeArg(['-r', '9518EE7A-48A2-4071-B436-169BA4AF21A3']), '9518ee7a-48a2-4071-b436-169ba4af21a3');
  assert.equal(agy.resumeArg(['--conversation=not-an-id']), null);
});

test('each window gets the newest open conversation begun since it started', () => {
  const A = 'aaaaaaaa-0000-4000-8000-000000000000';
  const B = 'bbbbbbbb-0000-4000-8000-000000000000';
  const C = 'cccccccc-0000-4000-8000-000000000000';
  const D = 'dddddddd-0000-4000-8000-000000000000';
  const convs = [
    { id: A, begunAt: 1000 },
    { id: B, begunAt: 5000 },
    { id: C, begunAt: 9000 },
    { id: D, begunAt: 9500 },
  ];
  const wins = [
    { pid: 1, startedAt: 4000 },
    { pid: 2, startedAt: 8000 },
    { pid: 3, startedAt: 100, resume: A },
  ];
  const open = (id) => id !== D;
  const { byPid, unmatched } = agy.matchWindows(convs, wins, open);
  assert.equal(byPid.get(3).id, A, 'the one it was started on');
  assert.equal(byPid.get(2).id, C, 'the newest open one since it started; D is closed');
  assert.equal(byPid.get(1).id, B);
  assert.deepEqual(unmatched, []);

  // Where locks can't be seen, any begun since the window started will do.
  const unknown = agy.matchWindows(convs, [{ pid: 9, startedAt: 8000 }], () => null);
  assert.equal(unknown.byPid.get(9).id, D);
});

test('a new tab runs agy, resuming a conversation and skipping prompts only when asked', () => {
  assert.equal(agy.command(), 'agy');
  assert.equal(agy.command({ skipPermissions: true, resume: '9518ee7a-48a2-4071-b436-169ba4af21a3' }), 'agy --dangerously-skip-permissions --conversation 9518ee7a-48a2-4071-b436-169ba4af21a3');
  assert.equal(agy.command({ resume: 'x; rm -rf ~' }), 'agy', 'only an ID that could be one');
});
