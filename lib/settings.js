'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');

// Settings shared by every browser, unlike the ones the page keeps in its own
// storage. Each key has a check that returns the cleaned value, or undefined
// if the value isn't valid.
const DEFAULTS = { skipPermissions: false, excludedFolders: [], todoFolderSource: 'repos', todoStartFolder: '', terminal: 'auto', newSessionApp: 'claude' };
// The terminals new sessions can open in, on any platform. The terminal
// drivers say which of them this computer has.
const TERMINALS = ['auto', 'windows-terminal', 'terminal', 'iterm2', 'ghostty', 'kitty', 'wezterm', 'gnome-terminal', 'ptyxis', 'konsole', 'tmux'];
const MAX_FOLDERS = 100;
const ERRORS = { todoStartFolder: "That isn't a folder on this computer. Give its full path, or leave it empty." };

// A folder under the repos folder, as the repo menu names it:
// "work/acme". Either slash is accepted.
function folderPath(p) {
  if (typeof p !== 'string' || p.length > 260) return null;
  const parts = p.split(/[\\/]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.some((s) => s === '.' || s === '..' || /[<>:"|?*]/.test(s))) return null;
  return parts.join('/');
}

const CHECKS = {
  // Sessions the dashboard opens run with Claude's
  // --dangerously-skip-permissions, or Codex's
  // --dangerously-bypass-approvals-and-sandbox. Off unless chosen.
  skipPermissions(value) {
    return typeof value === 'boolean' ? value : undefined;
  },
  // The app the repo menu, and to-dos that don't name one, start sessions in.
  newSessionApp(value) {
    return value === 'claude' || value === 'codex' ? value : undefined;
  },
  // Left out of the repo menu, with everything inside them.
  excludedFolders(list) {
    if (!Array.isArray(list) || list.length > MAX_FOLDERS) return undefined;
    const paths = list.map(folderPath);
    if (paths.includes(null)) return undefined;
    const seen = new Set();
    return paths.filter((p) => {
      const key = p.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
  // The terminal that sessions the dashboard opens run in. Automatic picks
  // one this computer has.
  terminal(value) {
    return TERMINALS.includes(value) ? value : undefined;
  },
  // Where a to-do's folder is chosen from: the repo menu, or Windows' folder picker.
  todoFolderSource(value) {
    return value === 'repos' || value === 'picker' ? value : undefined;
  },
  // The folder that choice starts at, as a full path. Empty means the repos
  // folder, and ~ the home folder.
  todoStartFolder(value) {
    if (typeof value !== 'string' || value.length > 1000) return undefined;
    const p = value.trim().replace(/^~(?=$|[\\/])/, os.homedir());
    if (!p) return '';
    if (!path.isAbsolute(p)) return undefined;
    try {
      return fs.statSync(p).isDirectory() ? path.resolve(p) : undefined;
    } catch {
      return undefined;
    }
  },
};

// A hand-edited file can hold anything; keep only what passes the checks.
function load() {
  const saved = store.read('settings', {});
  const settings = { ...DEFAULTS };
  for (const [key, check] of Object.entries(CHECKS)) {
    const value = saved && typeof saved === 'object' && Object.hasOwn(saved, key) ? check(saved[key]) : undefined;
    if (value !== undefined) settings[key] = value;
  }
  return settings;
}

let current = load();

const get = () => current;

// Changes only the keys given, all or none.
function update(changes) {
  const next = { ...current };
  for (const [key, value] of Object.entries(changes || {})) {
    const clean = Object.hasOwn(CHECKS, key) ? CHECKS[key](value) : undefined;
    if (clean === undefined) return { ok: false, error: (Object.hasOwn(ERRORS, key) && ERRORS[key]) || `Not a valid value for ${key}.` };
    next[key] = clean;
  }
  try {
    store.write('settings', next);
  } catch (err) {
    return { ok: false, error: `Couldn't save settings: ${err.message}` };
  }
  current = next;
  return { ok: true, settings: current };
}

module.exports = { get, update };
