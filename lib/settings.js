'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const secrets = require('./secrets');
const trackers = require('./trackers');

// Settings shared by every browser, unlike the ones the page keeps in its own
// storage. Each key has a check that returns the cleaned value, or undefined
// if the value isn't valid. The secret ones are encrypted in the file.
const DEFAULTS = {
  skipPermissions: false,
  excludedFolders: [],
  todoFolderSource: 'repos',
  todoStartFolder: '',
  terminal: 'auto',
  newSessionApp: 'claude',
  comfyUrl: '',
  localaiUrl: '',
  localaiKey: '',
  ollamaUrl: '',
  lmstudioUrl: '',
  lmstudioKey: '',
  llamacppUrl: '',
  // Whether the server checks GitHub for a newer Tabherd: null until the
  // dashboard has asked, as nothing is sent anywhere unless someone says so.
  updateCheck: null,
  // Whether betas and other prereleases count as newer versions too.
  updatePrereleases: false,
  // Ticket trackers, with their sign-ins. Set through Settings → Tickets'
  // own routes, never with the rest.
  trackers: [],
};
// Kept encrypted in settings.json (see secrets.js): the keys and tokens, and
// the trackers whole, with their addresses and emails.
const SECRET = ['localaiKey', 'lmstudioKey', 'trackers'];
const isSet = (value) => (Array.isArray(value) ? value.length > 0 : Boolean(value));
// The terminals new sessions can open in, on any platform. The terminal
// drivers say which of them this computer has.
const TERMINALS = ['auto', 'windows-terminal', 'terminal', 'iterm2', 'ghostty', 'kitty', 'wezterm', 'gnome-terminal', 'ptyxis', 'konsole', 'tmux'];
const MAX_FOLDERS = 100;
const ERRORS = {
  todoStartFolder: "That isn't a folder on this computer. Give its full path, or leave it empty.",
  comfyUrl: 'Give an address such as http://127.0.0.1:8188, or leave it empty.',
  localaiUrl: 'Give an address such as http://127.0.0.1:8080, or leave it empty.',
  ollamaUrl: 'Give an address such as http://127.0.0.1:11434, or leave it empty.',
  lmstudioUrl: 'Give an address such as http://127.0.0.1:1234, or leave it empty.',
  llamacppUrl: 'Give an address such as http://127.0.0.1:8080, or leave it empty.',
};

// A folder under the repos folder, as the repo menu names it:
// "work/acme". Either slash is accepted.
function folderPath(p) {
  if (typeof p !== 'string' || p.length > 260) return null;
  const parts = p.split(/[\\/]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.some((s) => s === '.' || s === '..' || /[<>:"|?*]/.test(s))) return null;
  return parts.join('/');
}

// An http or https address, without a login in it, or empty.
function webAddress(value) {
  if (typeof value !== 'string' || value.length > 500) return undefined;
  const v = value.trim().replace(/\/+$/, '');
  if (!v) return '';
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password ? v : undefined;
  } catch {
    return undefined;
  }
}

// A key or token: one line, trimmed.
function oneLine(value) {
  return typeof value === 'string' && value.length <= 500 && !/[\r\n]/.test(value) ? value.trim() : undefined;
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
    return ['claude', 'codex', 'copilot'].includes(value) ? value : undefined;
  },
  // Where a ComfyUI that Comfy Desktop didn't start answers. Empty means
  // http://127.0.0.1:8188. Comfy Desktop's are found by themselves.
  comfyUrl: webAddress,
  // Where LocalAI answers. Empty means http://127.0.0.1:8080.
  localaiUrl: webAddress,
  // LocalAI's API key, if it has one set. Never sent back to the page.
  localaiKey: oneLine,
  // Where Ollama answers. Empty means OLLAMA_HOST, or http://127.0.0.1:11434.
  ollamaUrl: webAddress,
  // Where LM Studio's server answers. Empty means the port it last used, or
  // http://127.0.0.1:1234.
  lmstudioUrl: webAddress,
  // LM Studio's API token, if it requires one. Never sent back to the page.
  lmstudioKey: oneLine,
  // Where llama.cpp's server answers. Empty means LLAMA_ARG_HOST and
  // LLAMA_ARG_PORT, or http://127.0.0.1:8080.
  llamacppUrl: webAddress,
  // Yes or no to checking for a newer Tabherd. Once answered, it isn't asked again.
  updateCheck(value) {
    return typeof value === 'boolean' ? value : undefined;
  },
  updatePrereleases(value) {
    return typeof value === 'boolean' ? value : undefined;
  },
  trackers: trackers.cleanList,
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

// Secrets that are saved but couldn't be decrypted this run, as saved, so
// saving other settings doesn't lose them. Setting one replaces it.
let unreadable = {};

// A hand-edited file can hold anything; keep only what passes the checks.
// Secrets saved before they were encrypted are noted, to be encrypted now.
function load() {
  const saved = store.read('settings', {});
  const settings = { ...DEFAULTS };
  let plain = false;
  unreadable = {};
  for (const [key, check] of Object.entries(CHECKS)) {
    if (!saved || typeof saved !== 'object' || !Object.hasOwn(saved, key)) continue;
    let raw = saved[key];
    if (SECRET.includes(key)) {
      if (secrets.isEncrypted(raw)) {
        const value = secrets.decrypt(raw);
        if (value === undefined) {
          unreadable[key] = raw;
          continue;
        }
        raw = value;
      } else if (isSet(raw)) plain = true;
    }
    const value = check(raw);
    if (value !== undefined) settings[key] = value;
  }
  return { settings, plain };
}

// The settings as written: secrets encrypted, or as they were if they
// couldn't be read. Throws if they can't be encrypted, so none is written plain.
function forDisk(s) {
  const out = { ...s };
  for (const key of SECRET) {
    if (Object.hasOwn(unreadable, key)) out[key] = unreadable[key];
    else if (isSet(s[key])) out[key] = secrets.encrypt(s[key]);
  }
  return out;
}

const loaded = load();
let current = loaded.settings;
if (loaded.plain) {
  try {
    store.write('settings', forDisk(current));
  } catch {
    // Left as it was until a key can be made; Settings → Tickets says why.
  }
}

const get = () => current;

// Changes only the keys given, all or none. Trackers are changed only by the
// server's own routes for them (`internal`), which keep their tokens.
function update(changes, { internal = false } = {}) {
  const next = { ...current };
  for (const [key, value] of Object.entries(changes || {})) {
    const clean = Object.hasOwn(CHECKS, key) && (internal || key !== 'trackers') ? CHECKS[key](value) : undefined;
    if (clean === undefined) return { ok: false, error: (Object.hasOwn(ERRORS, key) && ERRORS[key]) || `Not a valid value for ${key}.` };
    next[key] = clean;
  }
  const replaced = Object.keys(changes || {}).filter((key) => Object.hasOwn(unreadable, key));
  const kept = { ...unreadable };
  for (const key of replaced) delete unreadable[key];
  try {
    store.write('settings', forDisk(next));
  } catch (err) {
    unreadable = kept;
    return { ok: false, error: `Couldn't save settings: ${err.message}` };
  }
  current = next;
  return { ok: true, settings: current };
}

// Secrets saved but not readable here, for Settings to say so.
const unreadableKeys = () => Object.keys(unreadable);

module.exports = { get, update, unreadableKeys };
