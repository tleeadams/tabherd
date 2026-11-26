'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TABHERD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-test-'));
const updates = require('../lib/updates');
const { version } = require('../package.json');

const page = (tag) => `https://github.com/tleeadams/tabherd/releases/tag/${tag}`;
const release = (tag, more) => ({ tag_name: tag, html_url: page(tag), body: `Notes for ${tag}`, published_at: '2026-11-26T00:00:00Z', prerelease: tag.includes('-'), ...more });

test('versions are in Semantic Versioning order', () => {
  const ordered = ['0.4.0', '0.5.0-1', '0.5.0-beta.1', '0.5.0-beta.2', '0.5.0-beta.10', '0.5.0-rc.1', '0.5.0', '0.5.1', '0.10.0', '1.0.0'];
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(updates.compare(ordered[i - 1], ordered[i]) < 0, `${ordered[i - 1]} before ${ordered[i]}`);
    assert.ok(updates.compare(ordered[i], ordered[i - 1]) > 0, `${ordered[i]} after ${ordered[i - 1]}`);
  }
  assert.equal(updates.compare('v0.5.0', '0.5.0'), 0);
});

test('a full release hears only of full releases, unless prereleases are asked for; a prerelease always hears of newer ones', () => {
  const releases = [
    release('v0.6.0-beta.2'),
    release('v0.5.1'),
    release('v0.5.0'),
    release('v0.7.0', { draft: true }),
    release('nightly'),
    null,
  ];
  assert.equal(updates.newest(releases, '0.5.0').version, '0.5.1');
  assert.equal(updates.newest(releases, '0.5.0', { prereleases: true }).version, '0.6.0-beta.2', 'asked for');
  assert.equal(updates.newest(releases, '0.6.0-beta.1').version, '0.6.0-beta.2');
  assert.equal(updates.newest(releases, '0.5.1'), null, 'nothing newer');
  assert.equal(updates.newest('not a list', '0.5.0'), null);
  const found = updates.newest(releases, '0.5.0');
  assert.deepEqual(found, { version: '0.5.1', url: page('v0.5.1'), notes: 'Notes for v0.5.1', published: '2026-11-26T00:00:00Z', prerelease: false });
  // A link that isn't to one of Tabherd's releases goes to the list of them.
  const elsewhere = updates.newest([release('v0.9.0', { html_url: 'https://example.com/download' })], '0.5.0');
  assert.equal(elsewhere.url, 'https://github.com/tleeadams/tabherd/releases/');
});

test('GitHub is asked only when allowed, at most once a day, or at once when asked', async () => {
  let asked = 0;
  const fetchReleases = () => {
    asked++;
    return [release('v100.0.0-beta.1'), release('v99.0.0'), release('v0.0.1')];
  };
  const t = Date.UTC(2026, 10, 25);

  await updates.check({ enabled: false, now: t, fetchReleases });
  assert.equal(asked, 0, 'not asked while it is off or unanswered');
  assert.equal(updates.summary(null).latest, null);

  await updates.check({ enabled: true, now: t, fetchReleases });
  assert.equal(asked, 1);
  assert.deepEqual(updates.summary(true, false, '1.0.0'), {
    check: true,
    prereleases: false,
    onPrerelease: false,
    version: '1.0.0',
    latest: { version: '99.0.0', url: page('v99.0.0'), prerelease: false },
    checkedAt: t,
    error: null,
  });
  // Turning prereleases on needs no new check; a prerelease counts them anyway.
  assert.equal(updates.summary(true, true, '1.0.0').latest.version, '100.0.0-beta.1');
  const onBeta = updates.summary(true, false, '1.0.0-beta.1');
  assert.deepEqual([onBeta.prereleases, onBeta.onPrerelease, onBeta.latest.version], [true, true, '100.0.0-beta.1']);
  assert.equal(updates.summary(true).version, version);
  const kept = JSON.parse(fs.readFileSync(path.join(process.env.TABHERD_DATA_DIR, 'updates.json'), 'utf8'));
  assert.deepEqual([kept.latest.version, kept.latestAny.version], ['99.0.0', '100.0.0-beta.1'], 'kept for the next run');

  await updates.check({ enabled: true, now: t + updates.DAY_MS - 1, fetchReleases });
  assert.equal(asked, 1, 'not again within the day');
  await updates.check({ enabled: false, now: t + 1000, force: true, fetchReleases });
  assert.equal(asked, 2, 'Check now asks at once, whatever the setting');
  await updates.check({ enabled: true, now: t + 1000 + updates.DAY_MS, fetchReleases });
  assert.equal(asked, 3, 'again a day after the last check');

  // A failed check keeps what the last one found, and tries again sooner.
  const failedAt = t + 1000 + 2 * updates.DAY_MS;
  await updates.check({ enabled: true, now: failedAt, fetchReleases: () => Promise.reject(new Error('offline')) });
  assert.equal(updates.summary(true, false, '1.0.0').latest.version, '99.0.0');
  assert.equal(updates.summary(true).error, 'offline');
  await updates.check({ enabled: true, now: failedAt + updates.RETRY_MS - 1, fetchReleases });
  assert.equal(asked, 3, 'not straight after a failure');
  await updates.check({ enabled: true, now: failedAt + updates.RETRY_MS, fetchReleases });
  assert.equal(asked, 4, 'an hour after it');
  assert.equal(updates.summary(true).error, null);

  // The dialog's details have the notes, which every snapshot leaves out.
  assert.equal(updates.details(true).latest.notes, 'Notes for v100.0.0-beta.1');
  assert.equal(updates.summary(true, true).latest.notes, undefined);
});

test('how this copy was installed is told from where it runs', () => {
  const kind = (root, platform, env = {}) => updates.installKind(root, { platform, env });
  assert.equal(updates.installKind(path.join(__dirname, '..')), 'git', 'this repository');
  assert.equal(kind('/opt/homebrew/Cellar/tabherd/0.5.0/libexec', 'darwin'), 'homebrew');
  assert.equal(kind('/home/linuxbrew/.linuxbrew/Cellar/tabherd/0.5.0/libexec', 'linux'), 'homebrew');
  assert.equal(kind('/usr/local/lib/node_modules/tabherd', 'linux'), 'npm');
  assert.equal(kind('/opt/homebrew/lib/node_modules/tabherd', 'darwin'), 'npm', "with Homebrew's Node");
  assert.equal(kind('/Users/me/.npm/_npx/0a1b2c3d4e5f6a7b/node_modules/tabherd', 'darwin'), 'npx');
  assert.equal(kind('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\tabherd', 'win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }), 'npm');
  assert.equal(kind('C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\0a1b2c3d4e5f6a7b\\node_modules\\tabherd', 'win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }), 'npx');
  assert.equal(kind('/Applications/Tabherd.app/Contents/Resources/server', 'darwin'), 'mac-app');
  assert.equal(kind('/usr/lib/Tabherd/server', 'linux'), 'linux-package');
  assert.equal(kind('/tmp/.mount_Tabher1/usr/lib/Tabherd/server', 'linux', { APPIMAGE: '/home/me/Tabherd.AppImage' }), 'appimage');
  assert.equal(kind('/home/me/.local/share/tabherd-linux-x64', 'linux'), 'archive');
  assert.equal(kind('C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\tleeadams.Tabherd_x\\tabherd-windows-x64\\server', 'win32'), 'winget');
  assert.equal(kind('C:\\Users\\me\\AppData\\Local\\Tabherd\\server', 'win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }), 'windows-installer');
  assert.equal(kind('D:\\Apps\\tabherd-windows-x64\\server', 'win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }), 'windows-zip');
});
