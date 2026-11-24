'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TABHERD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-test-'));
const settings = require('../lib/settings');

test('defaults are safe', () => {
  assert.deepEqual(settings.get(), {
    skipPermissions: false,
    excludedFolders: [],
    todoFolderSource: 'repos',
    todoStartFolder: '',
    terminal: 'auto',
    newSessionApp: 'claude',
    comfyUrl: '',
    localaiUrl: '',
    localaiKey: '',
  });
});

test("other apps' addresses must be web addresses, and LocalAI's key one line", () => {
  assert.equal(settings.update({ localaiUrl: ' http://127.0.0.1:8080/ ' }).settings.localaiUrl, 'http://127.0.0.1:8080');
  assert.equal(settings.update({ localaiUrl: 'file:///etc/passwd' }).ok, false);
  assert.equal(settings.update({ localaiUrl: 'http://user:pass@host' }).ok, false);
  assert.equal(settings.update({ localaiKey: 'abc\ndef' }).ok, false);
  assert.equal(settings.update({ comfyUrl: 'http://127.0.0.1:8190/' }).settings.comfyUrl, 'http://127.0.0.1:8190');
  assert.equal(settings.update({ comfyUrl: 'javascript:alert(1)' }).ok, false);
  assert.equal(settings.update({ comfyUrl: '', localaiUrl: '', localaiKey: '' }).ok, true);
});

test('new sessions start in Claude or Codex, nothing else', () => {
  assert.equal(settings.update({ newSessionApp: 'codex' }).settings.newSessionApp, 'codex');
  assert.equal(settings.update({ newSessionApp: 'bash' }).ok, false);
  assert.equal(settings.update({ newSessionApp: 'claude' }).settings.newSessionApp, 'claude');
});

test('each setting is checked', () => {
  assert.equal(settings.update({ skipPermissions: true }).settings.skipPermissions, true);
  assert.equal(settings.update({ skipPermissions: 'yes' }).ok, false);
  assert.equal(settings.update({ todoFolderSource: 'picker' }).settings.todoFolderSource, 'picker');
  assert.equal(settings.update({ todoFolderSource: 'anything' }).ok, false);
  assert.deepEqual(settings.update({ excludedFolders: ['a\\b', 'A/B/', 'c'] }).settings.excludedFolders, ['a/b', 'c']);
  assert.equal(settings.update({ excludedFolders: ['../up'] }).ok, false);
  assert.equal(settings.update({ ['__proto__']: 1 }).ok, false);
  assert.equal(settings.update({ terminal: 'iterm2' }).settings.terminal, 'iterm2');
  assert.equal(settings.update({ terminal: 'cmd.exe' }).ok, false);
});

test('the to-do start folder must exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-start-'));
  assert.equal(settings.update({ todoStartFolder: dir }).settings.todoStartFolder, path.resolve(dir));
  assert.equal(settings.update({ todoStartFolder: '~' }).settings.todoStartFolder, path.resolve(os.homedir()));
  assert.equal(settings.update({ todoStartFolder: '  ' }).settings.todoStartFolder, '');
  assert.equal(settings.update({ todoStartFolder: 'relative/path' }).ok, false);
  assert.equal(settings.update({ todoStartFolder: path.join(dir, 'missing') }).ok, false);
});

test('changes are all or none, and saved', () => {
  const before = settings.get();
  assert.equal(settings.update({ skipPermissions: !before.skipPermissions, todoFolderSource: 'nope' }).ok, false);
  assert.deepEqual(settings.get(), before);
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.TABHERD_DATA_DIR, 'settings.json'), 'utf8'));
  assert.deepEqual(saved, before);
});
