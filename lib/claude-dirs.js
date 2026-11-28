'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// The Claude Code folders whose sessions get cards. Each account Claude Code
// signs in to keeps its own folder: ~/.claude, or wherever CLAUDE_CONFIG_DIR
// points when it starts. Only the default is watched unless Settings adds
// more: other ~/.claude-* folders, found here to be chosen, or any folder
// given by its path.

// The default: CLAUDE_CONFIG_DIR as the server has it, else ~/.claude.
const DEFAULT = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
const FOUND_MS = 30000;

// The same folder, however its path is written.
const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const same = (a, b) => key(a) === key(b);
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

let found = [];
let foundAt = 0;

// The ~/.claude-* folders that Claude Code has used, other than the default:
// those with a sessions or projects folder in them.
function others() {
  if (Date.now() - foundAt < FOUND_MS) return found;
  let names = [];
  try {
    names = fs.readdirSync(os.homedir());
  } catch {}
  found = names
    .filter((n) => /^\.claude-./.test(n))
    .map((n) => path.join(os.homedir(), n))
    .filter((p) => !same(p, DEFAULT) && (isDir(path.join(p, 'sessions')) || isDir(path.join(p, 'projects'))))
    .sort();
  foundAt = Date.now();
  return found;
}

// A folder's name on the dashboard: its own name, such as .claude-work.
const label = (dir) => path.basename(dir);

let chosen = [];

// The folders Settings adds to the default, as full paths.
function configure(folders) {
  chosen = (Array.isArray(folders) ? folders : []).filter((p) => typeof p === 'string' && path.isAbsolute(p));
}

// The folders watched: the default first, then the ones Settings added that
// exist, each once.
function list() {
  const dirs = [DEFAULT];
  for (const p of chosen) if (isDir(p) && !dirs.some((d) => same(d, p))) dirs.push(path.resolve(p));
  return dirs;
}

// The watched folder that `dir` is, if it is one, else the default.
const watched = (dir) => (typeof dir === 'string' && list().find((d) => same(d, dir))) || DEFAULT;
const isDefault = (dir) => !dir || same(dir, DEFAULT);

module.exports = { DEFAULT, others, list, configure, label, watched, isDefault, same };
