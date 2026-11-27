#!/usr/bin/env node
'use strict';

// The branch rules (gitflow), in one place for the git hooks, CI and the
// GitHub setup:
//
//   main                 Releases only. Changes arrive as pull requests from
//                        release/ and hotfix/ branches, each tagged v<version>.
//   develop              Where work comes together. Pull requests from the
//                        branches below, and from main after a release.
//   feature/<name>       From develop, back into develop. bugfix/<name> too.
//   release/<version>    From develop, into main, then back into develop.
//   hotfix/<version>     From main, into main, then back into develop.
//   dependabot/...       Dependabot's dependency updates, into develop.
//
//   node scripts/gitflow.js setup            turn on the git hooks for this clone
//   node scripts/gitflow.js github           apply the rules to the GitHub repo, with gh
//   node scripts/gitflow.js check-pr <base> <head>
//   node scripts/gitflow.js pre-commit | pre-push   (run by the hooks)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOOKS = path.join(ROOT, '.githooks');
const RULESETS = path.join(ROOT, '.github', 'rulesets');
const PROTECTED = ['main', 'develop'];
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const PATTERNS = {
  feature: /^feature\/[a-z0-9][a-z0-9._-]*$/,
  bugfix: /^bugfix\/[a-z0-9][a-z0-9._-]*$/,
  release: new RegExp(`^release/(${VERSION})$`),
  hotfix: new RegExp(`^hotfix/(${VERSION})$`),
  // Named by Dependabot, such as dependabot/cargo/app/src-tauri/tauri-2.13.0.
  dependabot: /^dependabot\/\S+$/,
};
// The kinds of branch each protected branch takes pull requests from.
const MERGES_INTO = {
  main: ['release', 'hotfix'],
  develop: ['feature', 'bugfix', 'release', 'hotfix', 'main', 'dependabot'],
};
const NAMING =
  'Use feature/<name> or bugfix/<name> (lowercase, with dashes), or release/<version> or hotfix/<version>.';

// "feature", "bugfix", "release", "hotfix", "main" or "develop", or null for a
// name outside the model.
function kind(branch) {
  if (PROTECTED.includes(branch)) return branch;
  return Object.keys(PATTERNS).find((k) => PATTERNS[k].test(branch)) || null;
}

// The version a release/ or hotfix/ branch is for.
const versionOf = (branch) => (branch.match(PATTERNS.release) || branch.match(PATTERNS.hotfix) || [])[1] || null;

const checkBranch = (branch) => (kind(branch) ? null : `"${branch}" isn't a gitflow branch name. ${NAMING}`);

// What's wrong with a pull request from `head` into `base`, as messages.
// `project` is package.json's version and CHANGELOG.md's text as the merge
// would leave them. Pull requests into other branches aren't restricted.
function checkPullRequest(base, head, project) {
  const allowed = MERGES_INTO[base];
  if (!allowed) return [];
  if (!allowed.includes(kind(head))) {
    const from = allowed.map((k) => (PROTECTED.includes(k) ? k : `${k}/`)).join(', ');
    return [`${base} takes pull requests only from ${from}; "${head}" is none of those.`];
  }
  const version = base === 'main' ? versionOf(head) : null;
  if (!version) return [];
  const errors = [];
  if (project.version !== version) errors.push(`${head} should set package.json's version to ${version}; it's ${project.version}.`);
  if (!new RegExp(`^## \\[?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`, 'm').test(project.changelog)) {
    errors.push(`CHANGELOG.md needs a "## ${version}" section; the release notes come from it.`);
  }
  return errors;
}

function fail(message) {
  console.error(`gitflow: ${message}`);
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Commits go on feature/, bugfix/, release/ or hotfix/ branches. main and
// develop only take merges.
function preCommit() {
  let branch;
  try {
    branch = git('symbolic-ref', '--short', 'HEAD');
  } catch {
    return; // No branch, as in the middle of a rebase.
  }
  if (fs.existsSync(path.join(git('rev-parse', '--git-dir'), 'MERGE_HEAD'))) return; // Finishing a merge.
  if (PROTECTED.includes(branch)) fail(`Don't commit to ${branch} directly. Start a branch: git switch -c feature/<name>`);
  const error = checkBranch(branch);
  if (error) fail(`${error}\nRename this one with: git branch -m <new-name>`);
}

// Git passes one line per ref: <local ref> <local sha> <remote ref> <remote sha>.
function prePush(lines) {
  const zero = (sha) => /^0+$/.test(sha);
  const errors = [];
  for (const line of lines.split('\n').filter(Boolean)) {
    const [, localSha, remoteRef, remoteSha] = line.split(' ');
    if (!remoteRef.startsWith('refs/heads/') || zero(localSha)) continue; // Tags, and deleting a branch.
    const branch = remoteRef.slice('refs/heads/'.length);
    if (PROTECTED.includes(branch)) {
      // Creating main and develop is how a new repository starts.
      if (!zero(remoteSha)) errors.push(`${branch} only changes through pull requests. Push your branch and open one.`);
      continue;
    }
    const error = checkBranch(branch);
    if (error) errors.push(error);
  }
  if (errors.length) fail(errors.join('\n'));
}

function setup() {
  git('config', 'core.hooksPath', '.githooks');
  // On macOS and Linux, git only runs hooks marked executable.
  if (process.platform !== 'win32') for (const f of fs.readdirSync(HOOKS)) fs.chmodSync(path.join(HOOKS, f), 0o755);
  console.log('The gitflow hooks are on: commits and pushes are checked against the branch rules.');
}

// Applies .github/rulesets and the repository settings the rules need, to
// the GitHub repository this clone pushes to.
function github() {
  const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input });
  const repo = JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
  // The rulesets stop pushes that would create main or develop.
  for (const branch of PROTECTED) {
    try {
      gh(['api', `repos/${repo}/branches/${branch}`]);
    } catch {
      fail(`Push ${branch} to GitHub first: git push -u origin ${branch}`);
    }
  }
  const existing = JSON.parse(gh(['api', `repos/${repo}/rulesets`]));
  for (const file of fs.readdirSync(RULESETS).filter((f) => f.endsWith('.json'))) {
    const body = fs.readFileSync(path.join(RULESETS, file), 'utf8');
    const { name } = JSON.parse(body);
    const found = existing.find((r) => r.name === name);
    gh(['api', '-X', found ? 'PUT' : 'POST', `repos/${repo}/rulesets${found ? `/${found.id}` : ''}`, '--input', '-'], body);
    console.log(`${found ? 'Updated' : 'Added'} the "${name}" ruleset.`);
  }
  // Pull requests target develop unless chosen otherwise. Merge commits only,
  // so main and develop keep each branch's history and back-merges stay clean.
  gh(['api', '-X', 'PATCH', `repos/${repo}`, '-f', 'default_branch=develop', '-F', 'allow_merge_commit=true',
    '-F', 'allow_squash_merge=false', '-F', 'allow_rebase_merge=false', '-F', 'delete_branch_on_merge=true']);
  console.log('Set develop as the default branch, merge commits only, and merged branches deleted.');
  // SECURITY.md asks for reports through this.
  gh(['api', '-X', 'PUT', `repos/${repo}/private-vulnerability-reporting`]);
  console.log('Turned on private vulnerability reporting.');
  releaseEnvironment(repo, gh);
  checkReviewers(repo, gh);
}

// The jobs that sign and publish a release run in the release environment,
// and only they get its secrets and npm's trust. Only version tags can use
// it, and each run waits for a code owner to approve it, so a tag pushed by
// anything else that can write to the repository, such as a token or an app,
// gets nothing from it. Code owners can approve their own runs: until there
// are others, there's no one else to.
function releaseEnvironment(repo, gh) {
  const owners = codeOwners();
  const reviewers = owners.map((user) => ({ type: 'User', id: JSON.parse(gh(['api', `users/${user}`])).id }));
  const settings = {
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    reviewers,
    prevent_self_review: false,
    can_admins_bypass: false,
  };
  gh(['api', '-X', 'PUT', `repos/${repo}/environments/release`, '--input', '-'], JSON.stringify(settings));
  const policies = JSON.parse(gh(['api', `repos/${repo}/environments/release/deployment-branch-policies`])).branch_policies;
  if (!policies.some((p) => p.type === 'tag' && p.name === 'v*')) {
    gh(['api', '-X', 'POST', `repos/${repo}/environments/release/deployment-branch-policies`, '-f', 'name=v*', '-f', 'type=tag']);
  }
  console.log(`Set up the release environment: version tags only, each run approved by ${owners.join(', ')}.`);
}

// The users in .github/CODEOWNERS. Teams are left out.
function codeOwners() {
  const handles = fs
    .readFileSync(path.join(ROOT, '.github', 'CODEOWNERS'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .flatMap((line) => line.match(/@[\w-]+(?![\w/-])/g) || [])
    .map((handle) => handle.slice(1));
  return [...new Set(handles)];
}

// GitHub ignores code owners without write access, so their reviews wouldn't
// count. Teams are left to GitHub to check.
function checkReviewers(repo, gh) {
  for (const user of codeOwners()) {
    let permission = 'none';
    try {
      permission = JSON.parse(gh(['api', `repos/${repo}/collaborators/${user}/permission`])).permission;
    } catch {}
    if (['admin', 'maintain', 'write'].includes(permission)) continue;
    console.log(
      `${user} is in .github/CODEOWNERS but can't review yet. Give them write access: gh api -X PUT repos/${repo}/collaborators/${user} -f permission=push`,
    );
  }
  console.log(
    'Pull requests now need CI to pass and an approving review from someone in .github/CODEOWNERS. As the admin, you can ' +
      'merge one without waiting for either, with "gh pr merge --merge --admin". The Gitflow check still has to pass. ' +
      'A release waits for a code owner to approve its signing and publishing jobs.',
  );
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'pre-commit') return preCommit();
  if (command === 'pre-push') return prePush(fs.readFileSync(0, 'utf8'));
  if (command === 'setup') return setup();
  if (command === 'github') return github();
  if (command === 'check-branch') {
    const error = checkBranch(args[0] || '');
    return error ? fail(error) : console.log(`${args[0]} is a ${kind(args[0])} branch.`);
  }
  if (command === 'check-pr') {
    const [base, head] = args;
    const project = {
      version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
      changelog: fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'),
    };
    const errors = checkPullRequest(base, head, project);
    return errors.length ? fail(errors.join('\n')) : console.log(`A pull request from ${head} into ${base} follows the branch rules.`);
  }
  fail('Commands: setup, github, check-branch <name>, check-pr <base> <head>, pre-commit, pre-push.');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    fail(err.message);
  }
}

module.exports = { kind, versionOf, checkBranch, checkPullRequest };
