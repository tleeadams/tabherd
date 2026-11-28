'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TABHERD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-test-'));
// A key of the test's own, so the computer's key store isn't touched.
const secrets = require('../lib/secrets');
secrets.useKey(require('crypto').randomBytes(32));
const settings = require('../lib/settings');
const FILE = path.join(process.env.TABHERD_DATA_DIR, 'settings.json');
const onDisk = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
// The settings module again, as the server's next start loads it.
function reload() {
  delete require.cache[require.resolve('../lib/settings')];
  return require('../lib/settings');
}

test('defaults are safe', () => {
  assert.deepEqual(settings.get(), {
    skipPermissions: false,
    excludedFolders: [],
    todoFolderSource: 'repos',
    todoStartFolder: '',
    terminal: 'auto',
    newSessionApp: 'claude',
    claudeFolders: [],
    newSessionClaude: '',
    vscodeProfiles: {},
    comfyUrl: '',
    localaiUrl: '',
    localaiKey: '',
    ollamaUrl: '',
    lmstudioUrl: '',
    lmstudioKey: '',
    llamacppUrl: '',
    updateCheck: null,
    updatePrereleases: false,
    trackers: [],
  });
});

test('checking for updates is a yes or a no, once asked, and prereleases are too', () => {
  assert.equal(settings.update({ updateCheck: true }).settings.updateCheck, true);
  assert.equal(settings.update({ updateCheck: false }).settings.updateCheck, false);
  assert.equal(settings.update({ updateCheck: null }).ok, false, "can't go back to unasked");
  assert.equal(settings.update({ updateCheck: 'yes' }).ok, false);
  assert.equal(settings.update({ updatePrereleases: true }).settings.updatePrereleases, true);
  assert.equal(settings.update({ updatePrereleases: 1 }).ok, false);
  assert.equal(settings.update({ updatePrereleases: false }).settings.updatePrereleases, false);
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

test('new sessions start in Claude, Codex or Copilot, nothing else', () => {
  assert.equal(settings.update({ newSessionApp: 'codex' }).settings.newSessionApp, 'codex');
  assert.equal(settings.update({ newSessionApp: 'copilot' }).settings.newSessionApp, 'copilot');
  assert.equal(settings.update({ newSessionApp: 'opencode' }).settings.newSessionApp, 'opencode');
  assert.equal(settings.update({ newSessionApp: 'cursor' }).settings.newSessionApp, 'cursor');
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

test('keys and trackers are encrypted on disk, and read back', () => {
  assert.equal(settings.update({ localaiKey: 'sk-local-123', lmstudioUrl: 'http://127.0.0.1:1234' }).ok, true);
  const saved = onDisk();
  assert.match(saved.localaiKey, /^enc:v1:/);
  assert.ok(!fs.readFileSync(FILE, 'utf8').includes('sk-local-123'), 'the key is nowhere in the file');
  assert.equal(saved.lmstudioUrl, 'http://127.0.0.1:1234', 'plain settings stay readable');
  assert.equal(saved.lmstudioKey, '', 'an empty key is just empty');
  assert.equal(reload().get().localaiKey, 'sk-local-123');
  settings.update({ localaiKey: '', lmstudioUrl: '' });
});

test('trackers are only changed through their own routes', () => {
  const tracker = { id: '11111111-1111-4111-8111-111111111111', type: 'linear', name: 'Work', token: 'lin_api_x' };
  assert.equal(settings.update({ trackers: [tracker] }).ok, false, "the page's settings route can't set them");
  assert.equal(settings.update({ trackers: [tracker] }, { internal: true }).ok, true);
  assert.match(onDisk().trackers, /^enc:v1:/, 'the whole list is encrypted, addresses and all');
  assert.equal(reload().get().trackers[0].token, 'lin_api_x');
  settings.update({ trackers: [] }, { internal: true });
});

test('a key saved before encryption is encrypted on the next start', () => {
  fs.writeFileSync(FILE, JSON.stringify({ ...onDisk(), lmstudioKey: 'plain-token' }));
  const fresh = reload();
  assert.equal(fresh.get().lmstudioKey, 'plain-token');
  assert.match(onDisk().lmstudioKey, /^enc:v1:/);
  fresh.update({ lmstudioKey: '' });
});

test("a secret this computer can't decrypt counts as unset, and isn't lost by other changes", () => {
  const foreign = 'enc:v1:' + Buffer.alloc(48, 7).toString('base64');
  fs.writeFileSync(FILE, JSON.stringify({ ...onDisk(), localaiKey: foreign }));
  const fresh = reload();
  assert.equal(fresh.get().localaiKey, '');
  assert.deepEqual(fresh.unreadableKeys(), ['localaiKey']);
  fresh.update({ skipPermissions: false });
  assert.equal(onDisk().localaiKey, foreign, 'kept as it was');
  fresh.update({ localaiKey: 'new-key' });
  assert.notEqual(onDisk().localaiKey, foreign, 'setting it replaces it');
  assert.deepEqual(fresh.unreadableKeys(), []);
  fresh.update({ localaiKey: '' });
});

test('VS Code profiles are kept by account folder, and an empty name removes one', () => {
  const settings = require('../lib/settings');
  const dir = path.resolve(os.homedir(), '.claude-work');
  assert.equal(settings.update({ vscodeProfiles: { '': 'Personal', [dir]: ' Work ', '~/.claude-old': '' } }).ok, true);
  assert.deepEqual(settings.get().vscodeProfiles, { '': 'Personal', [dir]: 'Work' });
  assert.equal(settings.update({ vscodeProfiles: { relative: 'x' } }).ok, false);
  assert.equal(settings.update({ vscodeProfiles: { '': 'two\nlines' } }).ok, false);
});
