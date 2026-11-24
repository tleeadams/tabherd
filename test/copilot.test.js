'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A Copilot folder of the test's own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-copilot-'));
process.env.COPILOT_HOME = home;
const copilot = require('../lib/copilot');

const ID = '22222222-2222-4222-8222-222222222222';
const dir = path.join(home, 'session-state', ID);
const at = (s) => `2026-01-02T03:04:${String(s).padStart(2, '0')}.000Z`;
const event = (s, type, data) => `${JSON.stringify({ id: String(s), timestamp: at(s), parentId: null, type, data })}\n`;

test('a Copilot session open in a process gets a card, with its approval waiting', () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${ID}\ncwd: /home/user/project\nclient_name: github/cli\nname: "Check the build"\ncreated_at: ${at(0)}\n`);
  fs.writeFileSync(path.join(dir, `inuse.${process.pid}.lock`), String(process.pid));
  fs.writeFileSync(path.join(home, 'open-sessions-state.json'), JSON.stringify({ [ID]: { schemaVersion: 1, openedAt: at(0), working: false } }));
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    event(0, 'session.start', { selectedModel: 'gpt-test', copilotVersion: '1.0.114', context: { cwd: '/home/user/project', branch: 'main' } }) +
      event(1, 'user.message', { content: 'Run git --version', source: 'user' }) +
      event(2, 'assistant.turn_start', { turnId: 't1' }) +
      event(3, 'tool.execution_start', { toolCallId: 'c1', toolName: 'bash', toolTitle: 'Shell', arguments: { command: 'git --version' } }) +
      event(4, 'permission.requested', { requestId: 'r1', permissionRequest: { kind: 'shell', fullCommandText: 'git --version' } }),
  );
  let [a] = copilot.snapshot().agents;
  assert.equal(a.id, ID);
  assert.equal(a.pid, process.pid);
  assert.equal(a.name, 'Check the build');
  assert.equal(a.cwd, '/home/user/project');
  assert.equal(a.model, 'gpt-test');
  assert.equal(a.gitBranch, 'main');
  assert.equal(a.lastPrompt.text, 'Run git --version');
  assert.equal(a.status, 'waiting');
  assert.equal(a.waitingFor, 'Approval: run git --version');
  assert.deepEqual(a.tools.map((t) => [t.name, t.detail]), [['Shell', 'git --version']]);

  // Approved, run and answered.
  fs.appendFileSync(
    path.join(dir, 'events.jsonl'),
    event(5, 'permission.completed', { requestId: 'r1', result: { kind: 'approved' } }) +
      event(6, 'tool.execution_complete', { toolCallId: 'c1', success: true }) +
      // As real Copilot sessions record them: tokens and the model in auto
      // mode come with each model call, not with the reply.
      event(7, 'session.usage_record', { usage: { model: 'mai-code-2-flash', modelDisplayName: 'MAI Code 2 Flash', outputTokens: 12 } }) +
      event(7, 'assistant.message', { content: 'git version 2.50.0', model: 'mai-code-2-flash' }) +
      event(8, 'assistant.turn_end', { turnId: 't1' }),
  );
  [a] = copilot.snapshot().agents;
  assert.equal(a.status, 'idle');
  assert.equal(a.lastReply.text, 'git version 2.50.0');
  assert.equal(a.outputTokens, 12);
  assert.equal(a.modelName, 'MAI Code 2 Flash');
  assert.equal(a.prompts, 1);
});

test("the open list's working flag counts, and a session whose process is gone has no card", () => {
  fs.writeFileSync(path.join(home, 'open-sessions-state.json'), JSON.stringify({ [ID]: { schemaVersion: 1, working: true } }));
  assert.equal(copilot.stateOf({ approvals: [], asking: [], tools: [] }, { working: true }).status, 'busy');
  assert.deepEqual(copilot.stateOf({ approvals: [], asking: ['Which branch?'], tools: [] }, {}), { status: 'waiting', waitingFor: 'Question: Which branch?' });
  fs.unlinkSync(path.join(dir, `inuse.${process.pid}.lock`));
  fs.writeFileSync(path.join(dir, 'inuse.999999999.lock'), '999999999');
  // The candidate list is cached for a few seconds; a fresh module reads afresh.
  delete require.cache[require.resolve('../lib/copilot')];
  assert.deepEqual(require('../lib/copilot').snapshot().agents, []);
});

test('Copilot tabs start with a chosen ID and name, resume by ID, and can skip permission prompts', () => {
  assert.equal(copilot.command(), 'copilot');
  assert.equal(copilot.command({ resume: ID }), `copilot --resume=${ID}`);
  assert.equal(copilot.command({ skipPermissions: true, sessionId: ID, name: "'Fix it'" }), `copilot --allow-all --session-id=${ID} --name 'Fix it'`);
});

test("workspace.yaml's quoted values are read without their quotes", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-ws-'));
  fs.writeFileSync(path.join(d, 'workspace.yaml'), 'name: "Say \\"hi\\""\nsummary: ~\ncwd: C:\\Users\\me\\src\n');
  assert.deepEqual(copilot.readWorkspace(d), { name: 'Say "hi"', summary: null, cwd: 'C:\\Users\\me\\src' });
});
