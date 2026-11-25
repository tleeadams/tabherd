'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { kind, checkBranch, checkPullRequest } = require('../scripts/gitflow');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'gitflow.js');
const release = (version, changelog = `# Changelog\n\n## ${version} - 2026-12-01\n\n- Things.\n`) => ({ version, changelog });

test('branch names', () => {
  for (const [name, expected] of [
    ['main', 'main'],
    ['develop', 'develop'],
    ['feature/todo-cards', 'feature'],
    ['bugfix/stale-badge', 'bugfix'],
    ['release/0.2.0', 'release'],
    ['release/1.0.0-beta.1', 'release'],
    ['hotfix/0.2.1', 'hotfix'],
    ['dependabot/cargo/app/src-tauri/tauri-2.13.0', 'dependabot'],
  ]) {
    assert.equal(kind(name), expected, name);
  }
  for (const name of ['wip', 'feature/', 'feature/Todo', 'features/x', 'release/v0.2.0', 'release/0.2', 'hotfix/urgent', 'master']) {
    assert.equal(kind(name), null, name);
    assert.match(checkBranch(name), /isn't a gitflow branch name/);
  }
});

test('which branches may merge into develop and main', () => {
  const ok = (base, head, project = release('0.2.0')) => assert.deepEqual(checkPullRequest(base, head, project), [], `${head} -> ${base}`);
  const refused = (base, head) => assert.equal(checkPullRequest(base, head, release('0.2.0')).length, 1, `${head} -> ${base}`);
  for (const head of ['feature/x', 'bugfix/y', 'release/0.2.0', 'hotfix/0.2.1', 'main', 'dependabot/github_actions/actions/checkout-8']) ok('develop', head);
  for (const head of ['wip', 'develop']) refused('develop', head);
  ok('main', 'release/0.2.0');
  ok('main', 'hotfix/0.2.0');
  for (const head of ['feature/x', 'bugfix/y', 'develop', 'wip', 'dependabot/cargo/serde-1.0.300']) refused('main', head);
  ok('feature/x', 'anything', {});
});

test('a release or hotfix into main sets its version and changelog', () => {
  assert.match(checkPullRequest('main', 'release/0.3.0', release('0.2.0'))[0], /package\.json's version to 0\.3\.0/);
  assert.match(checkPullRequest('main', 'hotfix/0.2.1', { version: '0.2.1', changelog: '## 0.2.0\n' })[0], /"## 0\.2\.1"/);
  assert.equal(checkPullRequest('main', 'release/0.2.0', { version: '0.2.0', changelog: '## 0.2.01\n' }).length, 1);
  assert.deepEqual(checkPullRequest('main', 'release/0.2.0', { version: '0.2.0', changelog: '## [0.2.0]\n' }), []);
});

test('the pre-push hook refuses updates to main and develop, and stray names', () => {
  const zero = '0'.repeat(40);
  const sha = 'a'.repeat(40);
  const push = (...lines) => spawnSync(process.execPath, [SCRIPT, 'pre-push'], { input: lines.join('\n') + '\n' }).status;
  assert.equal(push(`refs/heads/main ${sha} refs/heads/main ${zero}`, `refs/heads/develop ${sha} refs/heads/develop ${zero}`), 0, 'creating them');
  assert.equal(push(`refs/heads/main ${sha} refs/heads/main ${'b'.repeat(40)}`), 1, 'updating main');
  assert.equal(push(`refs/heads/develop ${sha} refs/heads/develop ${'b'.repeat(40)}`), 1, 'updating develop');
  assert.equal(push(`refs/heads/feature/x ${sha} refs/heads/feature/x ${zero}`), 0);
  assert.equal(push(`refs/heads/wip ${sha} refs/heads/wip ${zero}`), 1);
  assert.equal(push(`refs/tags/v0.1.0 ${sha} refs/tags/v0.1.0 ${zero}`), 0, 'tags');
  assert.equal(push(`(delete) ${zero} refs/heads/feature/x ${sha}`), 0, 'deleting a branch');
});

test('the pre-commit hook allows commits only on working branches, and merges', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'start');
  const commit = () => spawnSync(process.execPath, [SCRIPT, 'pre-commit'], { cwd: repo }).status;
  for (const [branch, status] of [['main', 1], ['develop', 1], ['wip', 1], ['feature/x', 0], ['release/0.2.0', 0]]) {
    git('checkout', '-q', '-B', branch);
    assert.equal(commit(), status, branch);
  }
  git('checkout', '-q', 'develop');
  fs.writeFileSync(path.join(repo, '.git', 'MERGE_HEAD'), 'a'.repeat(40));
  assert.equal(commit(), 0, 'finishing a merge into develop');
});
