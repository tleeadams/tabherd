'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const settings = require('./settings');

const SOURCE_DIR = process.env.REPOS_DIR || path.join(os.homedir(), 'source');
const MAX_DEPTH = 6;
const CACHE_MS = 60000;
const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'bin', 'obj', 'target', 'venv', '__pycache__']);

let scan = null;
let scannedAt = 0;
let cache = null;

const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

// A folder with a .git entry (a directory, or a file for worktrees) is a repo.
// Repos are leaves: nothing inside one is searched.
function walk(dir, rel, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  if (rel && entries.some((e) => e.name === '.git')) return { name: path.basename(dir), path: rel, repo: true };
  if (depth >= MAX_DEPTH) return null;
  const folders = [];
  const repos = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const child = walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    if (child) (child.repo ? repos : folders).push(child);
  }
  if (!folders.length && !repos.length) return null;
  return { name: path.basename(dir), path: rel, children: [...folders.sort(byName), ...repos.sort(byName)] };
}

// The menu's tree: the scan without the excluded folders and repos, or the
// folders that have nothing left in them.
function prune(nodes, excluded, paths) {
  const out = [];
  for (const n of nodes) {
    if (excluded.has(n.path.toLowerCase())) continue;
    if (n.repo) {
      paths.add(n.path);
      out.push(n);
      continue;
    }
    const children = prune(n.children, excluded, paths);
    if (children.length) out.push({ ...n, children });
  }
  return out;
}

// `tree` is what the menu shows and `all` is everything found, for Settings.
// Changing the excluded folders doesn't need a rescan, only a new prune.
function scanRepos(force) {
  if (force || !scan || Date.now() - scannedAt > CACHE_MS) {
    scan = walk(SOURCE_DIR, '', 0)?.children || [];
    scannedAt = Date.now();
    cache = null;
  }
  const { excludedFolders } = settings.get();
  if (!cache || cache.excludedFolders !== excludedFolders) {
    const paths = new Set();
    const tree = prune(scan, new Set(excludedFolders.map((p) => p.toLowerCase())), paths);
    cache = { root: SOURCE_DIR, tree, all: scan, count: paths.size, paths, excludedFolders };
  }
  return cache;
}

// Only folders the scan found can be opened, never an arbitrary path.
function resolveRepo(rel) {
  const { paths } = scanRepos(false);
  return typeof rel === 'string' && paths.has(rel) ? path.join(SOURCE_DIR, ...rel.split('/')) : null;
}

module.exports = { scanRepos, resolveRepo, SOURCE_DIR };
