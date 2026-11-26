'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const refs = require('../lib/ticket-refs');

const claim = (key, hint = null) => ({ op: 'claim', key, hint });

test('Claim: lines name tickets, several at once, with where to look', () => {
  assert.deepEqual(refs.find('Claim: ABC-123'), [claim('ABC-123')]);
  assert.deepEqual(refs.find('Fix the login.\nClaim: abc-123, ENG-42'), [claim('ABC-123'), claim('ENG-42')], 'any case, keys upper case');
  assert.deepEqual(refs.find('Claim: ABC-1 ENG-2'), [claim('ABC-1'), claim('ENG-2')]);
  assert.deepEqual(refs.find('Claim: Linear ENG-42'), [claim('ENG-42', 'linear')]);
  assert.deepEqual(refs.find('Claim: Work Jira ABC-7'), [claim('ABC-7', 'work jira')], "a tracker's name");
  assert.deepEqual(refs.find('Claim: Zendesk 4567'), [claim('#4567', 'zendesk')]);
  assert.deepEqual(refs.find('Claim: octo/app#12; #13'), [claim('octo/app#12'), claim('#13')]);
  assert.deepEqual(refs.find('Claim: ABC-123 (the login bug)'), [claim('ABC-123')], 'a note after the key');
  assert.deepEqual(refs.find('  - **Claim:** `ABC-9`.', 'reply'), [claim('ABC-9')], 'as a reply may write it');
  assert.deepEqual(refs.find('Unclaim: ABC-123'), [{ op: 'unclaim', key: 'ABC-123', hint: null }]);
  assert.deepEqual(refs.find('Claim: https://example.atlassian.net/browse/ABC-5'), [claim('ABC-5', 'host:example.atlassian.net')]);
});

test("text that isn't a claim of the session's ticket is left alone", () => {
  assert.deepEqual(refs.find('This is like ABC-12, which we fixed.'), [], 'a key in passing');
  assert.deepEqual(refs.find('Next, Claim: ABC-12'), [], 'a claim in the middle of a line');
  assert.deepEqual(refs.find('Claim: the login bug'), [], 'no key');
  assert.deepEqual(refs.find('See https://example.atlassian.net/browse/ABC-5', 'reply'), [], "a reply's links");
  assert.deepEqual(refs.find(null), []);
});

test('links in prompts link tickets, in the order they come', () => {
  const text = [
    'Look at https://linear.app/acme/issue/ENG-42/fix-login and',
    'https://github.com/Octo/App/issues/12, then https://acme.zendesk.com/agent/tickets/4567',
    'and https://jira.example.com/jira/browse/OPS-3 or https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-77',
    'but not https://github.com/octo/app/pull/13',
  ].join('\n');
  assert.deepEqual(refs.find(text), [
    claim('ENG-42', 'linear'),
    claim('octo/app#12', 'github'),
    claim('#4567', 'host:acme.zendesk.com'),
    claim('OPS-3', 'host:jira.example.com'),
    claim('ABC-77', 'host:acme.atlassian.net'),
  ]);
  assert.deepEqual(refs.find('Unclaim: https://linear.app/acme/issue/ENG-42'), [{ op: 'unclaim', key: 'ENG-42', hint: 'linear' }], 'a link in an Unclaim line is given up');
});

test("a branch's name gives its tickets, but not versions or encodings", () => {
  assert.deepEqual(refs.inBranch('eng-42-fix-login'), [{ key: 'ENG-42', hint: null }], "Linear's own branch names");
  assert.deepEqual(refs.inBranch('feature/ABC-123_tidy'), [{ key: 'ABC-123', hint: null }]);
  assert.deepEqual(refs.inBranch('someone/abc-1-and-ops-2'), [
    { key: 'ABC-1', hint: null },
    { key: 'OPS-2', hint: null },
  ]);
  assert.deepEqual(refs.inBranch('123-fix-login'), [{ key: '#123', hint: 'github' }], 'made from a GitHub issue');
  assert.deepEqual(refs.inBranch('fix/issue-45'), [{ key: '#45', hint: 'github' }]);
  assert.deepEqual(refs.inBranch('fix-utf-8-names'), []);
  assert.deepEqual(refs.inBranch('release-v1-2'), []);
  assert.deepEqual(refs.inBranch('main'), []);
  assert.deepEqual(refs.inBranch(null), []);
});

test("a folder's branch and GitHub repository come from its .git, a worktree's too", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-refs-'));
  const repo = path.join(root, 'app');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/abc-1-fix\n');
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:Octo/App.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  fs.mkdirSync(path.join(repo, 'src'));
  assert.deepEqual(refs.repoOf(path.join(repo, 'src')), { branch: 'abc-1-fix', github: 'octo/app' }, 'from a folder inside it');
  const wt = path.join(root, 'app-wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
  fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/ops-9\n');
  fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  assert.deepEqual(refs.repoOf(wt), { branch: 'ops-9', github: 'octo/app' });
  assert.equal(refs.githubRepo('https://github.com/octo/app'), 'octo/app');
  assert.equal(refs.githubRepo('ssh://git@github.com/octo/app.git'), 'octo/app');
  assert.equal(refs.githubRepo('https://gitlab.com/octo/app.git'), null);
  assert.deepEqual(refs.repoOf(os.tmpdir()), { branch: null, github: null }, 'not in a repository');
});
