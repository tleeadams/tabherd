'use strict';

// The Config Assistant's VS Code profiles: one for each Claude account other
// than the default, so Claude (VS Code) signs in with that account even while
// VS Code is open on another. Each profile has the Claude Code extension, and
// its settings set CLAUDE_CONFIG_DIR in claudeCode.environmentVariables. Then
// Settings → Claude accounts names it, so the dashboard opens folders there.
//
// VS Code lists its profiles in globalStorage/storage.json, and keeps each
// one's settings in profiles/<location>/settings.json. A profile is made by
// opening a window in it, as `code --profile` makes one it doesn't find; the
// extension is then installed into it from the command line.

const fs = require('fs');
const os = require('os');
const path = require('path');

const EXTENSION = 'anthropic.claude-code';
const ENV_SETTING = 'claudeCode.environmentVariables';
// How long a new profile takes to appear in storage.json after its window opens.
const MADE_WAIT_MS = 20000;

// Where VS Code keeps its user data, by system.
function userDataDir(env = process.env, home = os.homedir()) {
  if (process.platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Code');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The profile's name for an account: "Claude: work" for .claude-work.
const profileName = (dir) => `Claude: ${path.basename(dir).replace(/^\.claude-?/, '') || 'default'}`;

// VS Code's profiles: [{ name, location }], location being its folder's name.
function profiles(dataDir) {
  const list = readJson(path.join(dataDir, 'User', 'globalStorage', 'storage.json'))?.userDataProfiles;
  return Array.isArray(list) ? list.filter((p) => p?.name && p?.location && !String(p.location).startsWith('builtin/')) : [];
}

const profileDir = (dataDir, p) => path.join(dataDir, 'User', 'profiles', p.location);

function hasExtension(dataDir, p) {
  const list = readJson(path.join(profileDir(dataDir, p), 'extensions.json'));
  return Array.isArray(list) && list.some((e) => String(e?.identifier?.id || '').toLowerCase() === EXTENSION);
}

// The CLAUDE_CONFIG_DIR its settings give Claude, or null. undefined if its
// settings can't be read as plain JSON, as when they have comments.
function accountSet(dataDir, p) {
  const file = path.join(profileDir(dataDir, p), 'settings.json');
  if (!fs.existsSync(file)) return null;
  const s = readJson(file);
  if (!s || typeof s !== 'object') return undefined;
  const v = Array.isArray(s[ENV_SETTING]) ? s[ENV_SETTING].find((e) => e?.name === 'CLAUDE_CONFIG_DIR') : null;
  return v ? String(v.value) : null;
}

const same = (a, b) => Boolean(a && b) && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

// One account's state: its profile, what's done, and the steps left.
function itemFor(dir, { dataDir, chosen }) {
  const name = profileName(dir);
  const p = profiles(dataDir).find((x) => x.name === name);
  const set = p ? accountSet(dataDir, p) : null;
  const steps = [
    { key: 'make', label: `Make the VS Code profile “${name}”. A VS Code window opens in it, which you can close.`, done: Boolean(p) },
    { key: 'extension', label: 'Install the Claude Code extension in it.', done: Boolean(p) && hasExtension(dataDir, p) },
    { key: 'account', label: `Set CLAUDE_CONFIG_DIR to ${dir} in its settings.`, done: same(set, dir) },
    { key: 'tabherd', label: `Have Claude (VS Code) open folders in it for ${path.basename(dir)}.`, done: chosen === name },
  ];
  const problem = set === undefined ? `Its settings.json has comments or isn't plain JSON, so it's left alone. Set ${ENV_SETTING} there yourself.` : null;
  return {
    key: dir,
    label: path.basename(dir),
    detail: dir,
    status: problem ? 'problem' : steps.every((s) => s.done) ? 'done' : 'needed',
    problem,
    steps,
  };
}

// The task, with an item for each Claude account but the default. Not shown
// without VS Code, or with only the default account.
function check({ vscode, accounts, dataDir = userDataDir(), chosenProfiles = {} }) {
  if (!vscode.installed() || !accounts.length) return null;
  const chosen = (dir) => chosenProfiles[Object.keys(chosenProfiles).find((k) => k && same(k, dir))];
  return {
    id: 'vscode-profiles',
    title: 'A VS Code profile for each Claude account',
    why: 'Claude (VS Code) signs in with the account VS Code started with. A profile for each account lets to-dos open Claude on the account Settings chooses, even while VS Code is open.',
    items: accounts.map((dir) => itemFor(dir, { dataDir, chosen: chosen(dir) })),
  };
}

// Writes the account into the profile's settings, keeping a copy of the file
// as it was for Undo. A file that isn't plain JSON is left alone.
function setAccount(dataDir, p, dir, record) {
  const file = path.join(profileDir(dataDir, p), 'settings.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const s = before === null ? {} : readJson(file);
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: `${file} has comments or isn't plain JSON, so it was left alone.` };
  const env = (Array.isArray(s[ENV_SETTING]) ? s[ENV_SETTING] : []).filter((e) => e?.name !== 'CLAUDE_CONFIG_DIR');
  s[ENV_SETTING] = [...env, { name: 'CLAUDE_CONFIG_DIR', value: dir }];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
  record.settingsFile = file;
  record.settingsBefore = before;
  return { ok: true };
}

async function waitForProfile(dataDir, name, wait = MADE_WAIT_MS) {
  const until = Date.now() + wait;
  for (;;) {
    const p = profiles(dataDir).find((x) => x.name === name);
    if (p || Date.now() > until) return p || null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Does what's left for an account. `record` is filled with what Undo needs.
async function apply(dir, { vscode, dataDir = userDataDir(), setProfile, record = {}, wait }) {
  const name = profileName(dir);
  let p = profiles(dataDir).find((x) => x.name === name);
  if (!p) {
    const made = await vscode.code(['--profile', name, '--new-window']);
    if (!made.ok) return { ok: false, error: `Couldn't make the profile: ${made.error}` };
    p = await waitForProfile(dataDir, name, wait);
    if (!p) return { ok: false, error: `VS Code didn't make the profile “${name}”. Try again once its window is open.` };
    record.madeProfile = name;
  }
  if (!hasExtension(dataDir, p)) {
    const installed = await vscode.code(['--profile', name, '--install-extension', EXTENSION], { timeout: 180000 });
    if (!installed.ok) return { ok: false, error: `Couldn't install the Claude Code extension in it: ${installed.error}` };
  }
  if (!same(accountSet(dataDir, p), dir)) {
    const set = setAccount(dataDir, p, dir, record);
    if (!set.ok) return set;
  }
  record.profile = name;
  record.previousProfile = await setProfile(dir, name);
  return { ok: true, done: `“${name}” is ready: Claude (VS Code) opens folders there for ${path.basename(dir)}.` };
}

// Puts back what Apply changed: the profile's settings as they were, and the
// profile Settings named before. VS Code can't remove a profile from its
// command line, so one Apply made stays, to remove in VS Code if you like.
async function undo(dir, { record, setProfile }) {
  if (record.settingsFile) {
    if (record.settingsBefore === null) fs.rmSync(record.settingsFile, { force: true });
    else fs.writeFileSync(record.settingsFile, record.settingsBefore);
  }
  await setProfile(dir, record.previousProfile || '');
  const left = record.madeProfile ? ` The profile “${record.madeProfile}” is still in VS Code: remove it there (Manage → Profiles) if you don't want it.` : '';
  return { ok: true, done: `Put back how it was.${left}` };
}

module.exports = { check, apply, undo, profileName, profiles, userDataDir, ENV_SETTING };
