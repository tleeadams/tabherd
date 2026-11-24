'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A Claude folder and a Codex folder of the test's own, so nothing real is read.
const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-claude-'));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-codex-home-'));
const { snapshot } = require('../lib/agents');

const sessions = path.join(claudeDir, 'sessions');
const file = path.join(sessions, `${process.pid}.json`);
const ID = '77777777-7777-4777-8777-777777777777';
const register = (fields) =>
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: ID, cwd: os.tmpdir(), kind: 'interactive', status: 'busy', startedAt: Date.now(), ...fields }));
const ours = async () => (await snapshot()).agents.find((a) => a.id === ID);

test('a claude -p run is a background run, though Claude registers it as interactive', async () => {
  fs.mkdirSync(sessions, { recursive: true });
  register({ entrypoint: 'sdk-cli', name: 'PR review api#12' });
  const a = await ours();
  assert.equal(a.background, true);
  assert.equal(a.kind, 'interactive');
  register({ entrypoint: 'cli' });
  assert.equal((await ours()).background, false, 'a session in a terminal');
});

test("a registry file caught mid-rewrite keeps its last reading, so the session doesn't seem to end", async () => {
  register({ entrypoint: 'sdk-cli' });
  assert.ok(await ours());
  fs.writeFileSync(file, '{"pid": 12');
  assert.ok(await ours(), 'still there');
  fs.unlinkSync(file);
  assert.equal(await ours(), undefined, 'gone once the file is');
});
