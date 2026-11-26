'use strict';

const fs = require('fs');
const path = require('path');

// Finding the tickets a session is about: Claim: and Unclaim: lines in its
// prompts and replies, ticket links in its prompts, and keys in its branch's
// name. Nothing here is looked up, and a link is only read for its key, never
// fetched. See docs/ticket-links.md.
//
// A ref is { key, hint }. The key is "ABC-123" (Jira or Linear),
// "owner/repo#12" (GitHub) or "#12" (an issue in the session's own GitHub
// repository, or with a Zendesk hint, a Zendesk ticket). The hint, if any,
// says where to look: a tracker's type or name, lower case, or
// "host:<address>" from a link.

const MAX_PER_TEXT = 20;
const MAX_PER_LINE = 10;
const KEY = /^([A-Za-z][A-Za-z0-9_]{0,19})-([1-9]\d{0,8})$/;
const GITHUB = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})#([1-9]\d{0,8})$/;
const NUMBER = /^#?([1-9]\d{0,9})$/;
// A line that claims tickets, or gives them up: "Claim: ABC-123, ENG-42",
// maybe as a list item or in bold, as a reply may write it.
const CLAIM_LINE = /^\s*(?:[-*>]\s+)?[*_]*(claim|unclaim)[*_]*\s*:[*_]*\s*(.+?)\s*$/i;
// Text worth looking through: most isn't.
const MAYBE = /claim\s*:|\/browse\/|selectedIssue=|linear\.app\/|github\.com\/|\/agent\/tickets\//i;
// Words before a number in a branch's name that aren't a ticket's key:
// "utf-8", "v1-2", "release-3".
const NOT_A_KEY = /^(UTF|ISO|SHA|MD|RFC|CVE|IPV|HTTP|PY|NODE|ES|V\d+|PHASE|STEP|PART|WEEK|DAY|SPRINT|RELEASE|VERSION|FEATURE|BUGFIX|HOTFIX|FIX|TEST|ISSUES?|PR|PULL|MERGE)$/;

const LINKS = [
  // A Jira issue, on any site: /browse/ABC-123, or a board with it open.
  { re: /https?:\/\/([a-z0-9.-]+)(?::\d+)?(?:\/[^\s/?#]+)*?\/browse\/([A-Za-z][A-Za-z0-9_]*-[1-9]\d*)/gi, ref: (m) => ({ key: m[2].toUpperCase(), hint: `host:${m[1].toLowerCase()}` }) },
  { re: /https?:\/\/([a-z0-9.-]+)(?::\d+)?\/[^\s]*?[?&]selectedIssue=([A-Za-z][A-Za-z0-9_]*-[1-9]\d*)/gi, ref: (m) => ({ key: m[2].toUpperCase(), hint: `host:${m[1].toLowerCase()}` }) },
  { re: /https?:\/\/linear\.app\/[^\s/]+\/issue\/([A-Za-z][A-Za-z0-9]*-[1-9]\d*)/gi, ref: (m) => ({ key: m[1].toUpperCase(), hint: 'linear' }) },
  { re: /https?:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)\/issues\/([1-9]\d*)/gi, ref: (m) => ({ key: `${m[1]}/${m[2]}#${m[3]}`.toLowerCase(), hint: 'github' }) },
  { re: /https?:\/\/([a-z0-9.-]+)(?::\d+)?\/agent\/tickets\/([1-9]\d*)/gi, ref: (m) => ({ key: `#${m[2]}`, hint: `host:${m[1].toLowerCase()}` }) },
];

// The tickets linked in some text, in the order they're in it.
function linksIn(text) {
  const found = [];
  for (const { re, ref } of LINKS) for (const m of String(text).matchAll(re)) found.push({ at: m.index, ...ref(m) });
  return found.sort((a, b) => a.at - b.at).map(({ key, hint }) => ({ key, hint }));
}

// One key, as written: ABC-123, owner/repo#12, #12 or 12.
function keyIn(token) {
  const t = String(token).replace(/^[`'"([{<*_]+|[`'"\])}>*_.!?:]+$/g, '');
  let m = t.match(KEY);
  if (m) return `${m[1].toUpperCase()}-${m[2]}`;
  m = t.match(GITHUB);
  if (m) return `${m[1]}/${m[2]}#${m[3]}`.toLowerCase();
  m = t.match(NUMBER);
  return m ? `#${m[1]}` : null;
}

// What a claim line names: keys or links, separated by commas, each maybe
// with where to look first ("Linear ENG-42", "Zendesk 4567") or a note
// after it ("ABC-123 (the login bug)").
function itemsIn(list) {
  const refs = [];
  for (const part of String(list).split(/[,;]/)) {
    const item = part.trim();
    if (!item) continue;
    const links = linksIn(item);
    if (links.length) {
      refs.push(...links);
      continue;
    }
    const words = item.split(/\s+/);
    const keys = words.map(keyIn);
    if (keys.every(Boolean)) {
      for (const key of keys) refs.push({ key, hint: null });
    } else if (keys[keys.length - 1] && !keys.slice(0, -1).some(Boolean)) {
      const hint = words.slice(0, -1).join(' ').replace(/[*_`]/g, '').trim().toLowerCase();
      refs.push({ key: keys[keys.length - 1], hint: hint || null });
    } else if (keys[0] && !keys.slice(1).some(Boolean)) {
      refs.push({ key: keys[0], hint: null });
    }
  }
  return refs.slice(0, MAX_PER_LINE);
}

// Claims, unclaims and (in prompts) links in a prompt or reply, in order:
// [{ op: 'claim' | 'unclaim', key, hint }]. A key mentioned in passing isn't
// one: only a line that starts with Claim: or Unclaim: claims, and only a
// link you sent links.
function find(text, from = 'prompt') {
  const t = typeof text === 'string' ? text : '';
  if (!MAYBE.test(t)) return [];
  const found = [];
  for (const line of t.split(/\r?\n/)) {
    const claim = line.match(CLAIM_LINE);
    if (claim) for (const ref of itemsIn(claim[2])) found.push({ op: claim[1].toLowerCase(), ...ref });
    else if (from === 'prompt') for (const ref of linksIn(line)) found.push({ op: 'claim', ...ref });
    if (found.length >= MAX_PER_TEXT) break;
  }
  return found.slice(0, MAX_PER_TEXT);
}

// The tickets in a branch's name: keys anywhere in it, in any case, as
// Linear's own branch names are lower case ("eng-42-fix-login"), and a GitHub
// issue's number when its last part starts with one, as GitHub names a
// branch made from an issue ("123-fix-login").
function inBranch(branch) {
  const b = typeof branch === 'string' ? branch : '';
  const found = [];
  for (const m of b.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-([1-9]\d{0,6})(?=$|[^0-9])/g)) {
    const prefix = m[1].toUpperCase();
    if (!NOT_A_KEY.test(prefix)) found.push({ key: `${prefix}-${m[2]}`, hint: null });
  }
  const last = b.split('/').pop();
  const issue = last.match(/^([1-9]\d{0,8})-[A-Za-z]/) || last.match(/(?:^|[^A-Za-z])issues?[-_]?([1-9]\d{0,8})(?=$|[^0-9])/i);
  if (issue) found.push({ key: `#${issue[1]}`, hint: 'github' });
  return found.slice(0, 3);
}

const refId = (r) => `${r.hint || ''}|${r.key}`;

// ---- the repository a folder is in -------------------------------------------------

const REPO_CACHE_MS = 30000;
const repos = new Map();

// The .git folder for a folder in a repository, and the folder its config is
// in, which for a worktree is the main one's.
function gitDirs(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const dotGit = path.join(dir, '.git');
    let st;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = null;
    }
    if (st?.isDirectory()) return { git: dotGit, common: dotGit };
    if (st?.isFile()) {
      const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
      if (!m) return null;
      const git = path.resolve(dir, m[1]);
      let common = git;
      try {
        common = path.resolve(git, fs.readFileSync(path.join(git, 'commondir'), 'utf8').trim());
      } catch {}
      return { git, common };
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

// "owner/repo" from a GitHub remote's address, in any of its forms.
function githubRepo(url) {
  const m = String(url || '').match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

// A folder's branch, and its GitHub repository if its origin is on GitHub:
// { branch, github }. Read from its .git, not by running git, and kept for
// half a minute.
function repoOf(cwd, now = Date.now()) {
  if (typeof cwd !== 'string' || !cwd) return { branch: null, github: null };
  const hit = repos.get(cwd);
  if (hit && now - hit.at < REPO_CACHE_MS) return hit.info;
  let info = { branch: null, github: null };
  try {
    const dirs = gitDirs(cwd);
    if (dirs) {
      const head = fs.readFileSync(path.join(dirs.git, 'HEAD'), 'utf8').match(/^ref:\s*refs\/heads\/(.+?)\s*$/m);
      const config = fs.readFileSync(path.join(dirs.common, 'config'), 'utf8');
      const origin = config.match(/\[remote "origin"\][^[]*?^\s*url\s*=\s*(.+?)\s*$/m);
      info = { branch: head ? head[1] : null, github: origin ? githubRepo(origin[1]) : null };
    }
  } catch {}
  repos.set(cwd, { at: now, info });
  if (repos.size > 500) repos.delete(repos.keys().next().value);
  return info;
}

module.exports = { find, inBranch, itemsIn, linksIn, keyIn, refId, repoOf, githubRepo };
