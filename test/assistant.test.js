'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const profiles = require('../lib/assistant/vscode-profiles');

// A VS Code that makes profiles and installs extensions the way the real one
// records them, in a data folder of the test's own.
function fakeVscode(dataDir) {
  const calls = [];
  const storage = path.join(dataDir, 'User', 'globalStorage', 'storage.json');
  const list = () => JSON.parse(fs.readFileSync(storage, 'utf8')).userDataProfiles;
  fs.mkdirSync(path.dirname(storage), { recursive: true });
  fs.writeFileSync(storage, JSON.stringify({ userDataProfiles: [{ location: 'builtin/agents', name: 'Agents' }] }));
  return {
    calls,
    installed: () => true,
    async code(args) {
      calls.push(args);
      const name = args[args.indexOf('--profile') + 1];
      if (args.includes('--new-window')) {
        fs.writeFileSync(storage, JSON.stringify({ userDataProfiles: [...list(), { location: 'ab12cd34', name }] }));
        fs.mkdirSync(path.join(dataDir, 'User', 'profiles', 'ab12cd34'), { recursive: true });
      }
      if (args.includes('--install-extension')) {
        const p = list().find((x) => x.name === name);
        fs.writeFileSync(path.join(dataDir, 'User', 'profiles', p.location, 'extensions.json'), JSON.stringify([{ identifier: { id: 'anthropic.claude-code' } }]));
      }
      return { ok: true };
    },
  };
}

test('a profile is named after its account', () => {
  assert.equal(profiles.profileName('C:\\Users\\a\\.claude-work'), 'Claude: work');
  assert.equal(profiles.profileName('/home/a/.claude'), 'Claude: default');
});

test('the task only shows with VS Code and an account other than the default', () => {
  const vscode = { installed: () => true };
  assert.equal(profiles.check({ vscode, accounts: [] }), null);
  assert.equal(profiles.check({ vscode: { installed: () => false }, accounts: ['/x/.claude-work'] }), null);
});

test("Apply makes the profile, installs the extension, sets the account and names it; Undo puts the settings back", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-data-'));
  const dir = path.join(dataDir, '.claude-work');
  const vscode = fakeVscode(dataDir);
  let chosen = { [dir]: 'Old profile' };
  const setProfile = async (d, name) => {
    const before = chosen[d] || '';
    chosen = { ...chosen, [d]: name };
    return before;
  };

  const before = profiles.check({ vscode, accounts: [dir], dataDir, chosenProfiles: chosen }).items[0];
  assert.equal(before.status, 'needed');
  assert.deepEqual(before.steps.map((s) => s.done), [false, false, false, false]);

  const record = {};
  const r = await profiles.apply(dir, { vscode, dataDir, setProfile, record, wait: 1000 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(vscode.calls, [
    ['--profile', 'Claude: work', '--new-window'],
    ['--profile', 'Claude: work', '--install-extension', 'anthropic.claude-code'],
  ]);
  const settingsFile = path.join(dataDir, 'User', 'profiles', 'ab12cd34', 'settings.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { [profiles.ENV_SETTING]: [{ name: 'CLAUDE_CONFIG_DIR', value: dir }] });
  assert.equal(chosen[dir], 'Claude: work');
  assert.equal(profiles.check({ vscode, accounts: [dir], dataDir, chosenProfiles: chosen }).items[0].status, 'done');

  // Done already: nothing more is run.
  assert.equal((await profiles.apply(dir, { vscode, dataDir, setProfile, record: { ...record }, wait: 1000 })).ok, true);
  assert.equal(vscode.calls.length, 2);

  const u = await profiles.undo(dir, { record, setProfile });
  assert.equal(u.ok, true);
  assert.equal(fs.existsSync(settingsFile), false, 'it had no settings before');
  assert.equal(chosen[dir], 'Old profile');
  assert.match(u.done, /still in VS Code/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("settings with comments are left alone", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-data-'));
  const dir = path.join(dataDir, '.claude-work');
  const vscode = fakeVscode(dataDir);
  await vscode.code(['--profile', 'Claude: work', '--new-window']);
  const file = path.join(dataDir, 'User', 'profiles', 'ab12cd34', 'settings.json');
  fs.writeFileSync(file, '{\n  // mine\n  "editor.fontSize": 14\n}\n');
  const item = profiles.check({ vscode, accounts: [dir], dataDir }).items[0];
  assert.equal(item.status, 'problem');
  const r = await profiles.apply(dir, { vscode, dataDir, setProfile: async () => '', record: {}, wait: 1000 });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  // mine\n  "editor.fontSize": 14\n}\n');
  fs.rmSync(dataDir, { recursive: true, force: true });
});
