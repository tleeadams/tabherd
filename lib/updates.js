'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { version } = require('../package.json');

// Whether a newer Tabherd is out, from GitHub's list of its releases. The
// server only asks once Settings says yes, which the dashboard asks once, or
// when someone clicks Check now: the README promises nothing is sent anywhere
// unless it's asked for. It asks at most once a day, and sends nothing about
// this computer or its sessions.
const RELEASES = 'https://api.github.com/repos/tleeadams/tabherd/releases?per_page=30';
const RELEASE_PAGES = 'https://github.com/tleeadams/tabherd/releases/';
const DAY_MS = 24 * 60 * 60 * 1000;
// After a check that failed, as when the computer was offline, the next is
// sooner.
const RETRY_MS = 60 * 60 * 1000;
const MAX_NOTES = 20000;

// A version's parts, to compare: 0.6.0-beta.2 is 0, 6 and 0, then beta and 2.
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v));
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

// Below zero if a comes before b, in Semantic Versioning's order: a
// prerelease comes before its release, and beta.2 before beta.10.
function compare(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (typeof p !== typeof q) return typeof p === 'number' ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const isPrerelease = (v) => parse(v)?.pre.length > 0;

// A release as it's kept and shown, or null. Its page must be one of
// Tabherd's on GitHub.
function clean(r) {
  if (!r || typeof r !== 'object' || !parse(r.version)) return null;
  return {
    version: String(r.version).replace(/^v/, ''),
    url: typeof r.url === 'string' && r.url.startsWith(RELEASE_PAGES) ? r.url : RELEASE_PAGES,
    notes: typeof r.notes === 'string' ? r.notes.slice(0, MAX_NOTES) : '',
    published: typeof r.published === 'string' ? r.published : null,
    prerelease: Boolean(r.prerelease),
  };
}

// The newest release in GitHub's list, or null: of full releases only, or of
// prereleases too.
function newestOf(releases, prereleases) {
  const found = (Array.isArray(releases) ? releases : [])
    .filter((r) => r && !r.draft && (prereleases || !r.prerelease))
    .map((r) => clean({ version: r.tag_name, url: r.html_url, notes: r.body, published: r.published_at, prerelease: r.prerelease }))
    .filter(Boolean)
    .sort((a, b) => compare(b.version, a.version));
  return found[0] || null;
}

// Whether prereleases count as newer versions: when Settings asks for them,
// and always for someone already on one, who hears of the next.
const countsPrereleases = (prereleases, current) => Boolean(prereleases) || isPrerelease(current);

// The newest release after `current`, from GitHub's list, or null.
function newest(releases, current = version, { prereleases = false } = {}) {
  const found = newestOf(releases, countsPrereleases(prereleases, current));
  return found && compare(found.version, current) > 0 ? found : null;
}

async function fromGitHub() {
  const res = await fetch(RELEASES, {
    // GitHub's API asks for a name. Only the app's is sent.
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Tabherd' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

// The last check, kept in ~/.tabherd/updates.json, so a server started again,
// as the desktop app does each time it opens, doesn't ask again that day. It
// keeps the newest full release and the newest of all, so turning
// prereleases on or off needs no new check.
function load() {
  const saved = store.read('updates', null);
  const ok = saved && typeof saved === 'object';
  const time = (t) => (ok && Number.isFinite(t) ? t : 0);
  return {
    checkedAt: time(saved?.checkedAt),
    failedAt: time(saved?.failedAt),
    latest: ok ? clean(saved.latest) : null,
    latestAny: ok ? clean(saved.latestAny) : null,
    error: ok && typeof saved.error === 'string' ? saved.error : null,
  };
}

let state = load();
let checking = null;

// Asks GitHub when `enabled` and the last check is a day old, or at once if
// `force`d, as Check now does. A failed check keeps what the last one found.
function check({ enabled = false, force = false, now = Date.now(), fetchReleases = fromGitHub } = {}) {
  const due = now - state.checkedAt >= DAY_MS && now - state.failedAt >= RETRY_MS;
  if (!force && !(enabled && due)) return Promise.resolve(state);
  checking ||= Promise.resolve()
    .then(fetchReleases)
    .then(
      (releases) => ({ checkedAt: now, failedAt: 0, latest: newestOf(releases, false), latestAny: newestOf(releases, true), error: null }),
      (err) => ({ ...state, failedAt: now, error: err?.message || String(err) }),
    )
    .then((next) => {
      state = next;
      try {
        store.write('updates', state);
      } catch {}
      return state;
    })
    .finally(() => {
      checking = null;
    });
  return checking;
}

// The release found, if it's newer than this one, counting prereleases or
// not. Once this copy is updated to it, it isn't.
function newer(prereleases, current) {
  const found = countsPrereleases(prereleases, current) ? state.latestAny : state.latest;
  return found && compare(found.version, current) > 0 ? found : null;
}

// For every snapshot: this version, whether checking is on (null until it's
// been asked), whether prereleases count and whether this is one, and the
// newer release, without its notes.
function summary(updateCheck, prereleases = false, current = version) {
  const latest = newer(prereleases, current);
  return {
    check: updateCheck,
    prereleases: countsPrereleases(prereleases, current),
    onPrerelease: isPrerelease(current),
    version: current,
    latest: latest && { version: latest.version, url: latest.url, prerelease: latest.prerelease },
    checkedAt: state.checkedAt || null,
    error: state.failedAt > state.checkedAt ? state.error : null,
  };
}

// For the update dialog: the newer release with its notes, and how this copy
// was installed, so it can say how to update it.
const details = (prereleases = false) => ({ version, latest: newer(prereleases, version), install: installKind() });

// How this copy was installed, from where it runs: a clone of the repository,
// Homebrew, npm or npx, winget, the desktop app's installer or packages, or a
// download unpacked somewhere.
function installKind(root = path.join(__dirname, '..'), { platform = process.platform, env = process.env } = {}) {
  const slashed = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const dir = slashed(root);
  if (fs.existsSync(path.join(root, '.git'))) return 'git';
  if (/\/Cellar\/tabherd\//i.test(dir)) return 'homebrew';
  // npx keeps what it runs in _npx, in npm's cache.
  if (/\/node_modules\/tabherd$/i.test(dir)) return /\/_npx\//.test(dir) ? 'npx' : 'npm';
  if (env.APPIMAGE) return 'appimage';
  if (/\.app\/Contents\/Resources\//.test(dir)) return 'mac-app';
  if (/^\/usr\/lib(64)?\/Tabherd\//.test(dir)) return 'linux-package';
  if (platform === 'win32') {
    if (/\/Microsoft\/WinGet\/Packages\//i.test(dir)) return 'winget';
    const installed = env.LOCALAPPDATA && `${slashed(env.LOCALAPPDATA)}/Tabherd/`.toLowerCase();
    if (installed && dir.toLowerCase().startsWith(installed)) return 'windows-installer';
    return 'windows-zip';
  }
  return 'archive';
}

module.exports = { check, summary, details, compare, newest, installKind, DAY_MS, RETRY_MS };
