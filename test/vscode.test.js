'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('../lib/vscode');

test("VS Code's link fills in the prompt, with nothing else", () => {
  assert.equal(vscode.claudeLink(''), 'vscode://anthropic.claude-code/open');
  assert.equal(vscode.claudeLink('Fix the login page\n\nIt 500s & logs out'), 'vscode://anthropic.claude-code/open?prompt=Fix+the+login+page%0A%0AIt+500s+%26+logs+out');
});

test('VS Code is run without a shell, as its code.cmd runs it on Windows', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(dir, 'abc123', 'resources', 'app', 'out'), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'Code.exe'), '');
  fs.writeFileSync(path.join(dir, 'abc123', 'resources', 'app', 'out', 'cli.js'), '');
  fs.writeFileSync(path.join(bin, 'code.cmd'), '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\Code.exe" "%~dp0..\\abc123\\resources\\app\\out\\cli.js" %*\r\n');
  assert.deepEqual(vscode.findCli({ PATH: bin }), {
    cmd: path.join(dir, 'Code.exe'),
    args: [path.join(dir, 'abc123', 'resources', 'app', 'out', 'cli.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the Claude Code extension is found among VS Code extensions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  assert.equal(vscode.hasExtension(home), false);
  fs.mkdirSync(path.join(home, '.vscode', 'extensions', 'anthropic.claude-code-2.1.332-win32-x64'), { recursive: true });
  assert.equal(vscode.hasExtension(home), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a to-do takes the first Claude session VS Code starts in its folder, and no other's", () => {
  const cwd = path.resolve('/work/acme/api');
  const got = [];
  vscode.expect(cwd, (id) => got.push(id), 2500);
  const agent = (id, fields) => ({ app: 'claude', id, entrypoint: 'claude-vscode', cwd, startedAt: 5000, ...fields });
  const agents = [
    agent('terminal', { entrypoint: 'cli' }),
    agent('elsewhere', { cwd: path.resolve('/work/acme/web') }),
    agent('before', { startedAt: 100 }),
    agent('linked', { startedAt: 2000 }),
    agent('later', { startedAt: 9000 }),
    agent('this', { startedAt: 3000 }),
  ];
  vscode.settle(agents, { now: 6000, taken: (id) => id === 'linked' });
  assert.deepEqual(got, ['this']);
  vscode.settle(agents, { now: 7000 });
  assert.deepEqual(got, ['this'], 'once linked, it waits no more');
});
