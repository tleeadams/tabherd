'use strict';

// Each upcoming version keeps only its newest prerelease on the releases page.
// The prereleases a published release supersedes go back to drafts, which only
// the repository's maintainers can see. Their files and notes are kept, and
// publishing one on GitHub brings it back.
// - A newer prerelease of the same version hides the older ones:
//   1.2.3-beta.1 hides 1.2.3-alpha.3.
// - A version's release hides its prereleases, and so does any later release:
//   1.2.4 hides a 1.2.3-beta.1 whose 1.2.3 never came out.
// - A prerelease of another version stays: 1.2.4-alpha.1 doesn't hide
//   1.2.3-beta.1.
// Releases themselves are never hidden.
//
// .github/workflows/prune-prereleases.yml runs it when a release is published.
// By hand, with gh signed in: node scripts/prune-prereleases.js [--dry-run]

const { execFileSync } = require('child_process');

// v1.2.3-beta.1 → { core: [1, 2, 3], pre: ['beta', 1] }, or null if it isn't a version.
function parse(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(tag));
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

const compareCore = (a, b) => a.core[0] - b.core[0] || a.core[1] - b.core[1] || a.core[2] - b.core[2];

// Semantic Versioning's order: below zero if a comes before b.
function compare(a, b) {
  const core = compareCore(a, b);
  if (core) return core;
  // A version's release comes after all its prereleases.
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// The published prereleases that a newer one of their version, or a release
// of their version or a later one, supersedes. Drafts don't count either way.
function superseded(releases) {
  const shown = releases.filter((r) => !r.draft).map((r) => ({ release: r, v: parse(r.tag_name) })).filter((r) => r.v);
  return shown
    .filter(
      (p) =>
        p.v.pre.length &&
        shown.some((q) => q !== p && ((compareCore(q.v, p.v) === 0 && compare(q.v, p.v) > 0) || (!q.v.pre.length && compareCore(q.v, p.v) > 0))),
    )
    .map((p) => p.release);
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const repo = process.env.GITHUB_REPOSITORY || gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  const releases = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])).flat();
  const hide = superseded(releases);
  if (!hide.length) console.log('No prereleases to hide.');
  for (const r of hide) {
    console.log(`${dryRun ? 'Would hide' : 'Hiding'} ${r.tag_name}`);
    if (!dryRun) gh(['api', '-X', 'PATCH', `repos/${repo}/releases/${r.id}`, '-F', 'draft=true', '--silent']);
  }
}

if (require.main === module) main();

module.exports = { parse, compare, superseded };
