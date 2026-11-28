'use strict';

// The Config Assistant: setup that changes other apps, such as a VS Code
// profile for each Claude account, kept apart from the dashboard on a page of
// its own. Each task says whether it applies to this computer, and what it
// would change, before anything is changed; Apply does that, and Undo puts it
// back. What Undo needs is kept in ~/.tabherd/assistant.json.

const store = require('../store');
const settings = require('../settings');
const claudeDirs = require('../claude-dirs');
const vscode = require('../vscode');
const vscodeProfiles = require('./vscode-profiles');

const TASKS = { 'vscode-profiles': vscodeProfiles };

const records = () => store.read('assistant', { records: {} }).records || {};
const saveRecords = (r) => store.write('assistant', { records: r });
const recordKey = (task, key) => `${task}\u0000${key}`;

// Names the VS Code profile Claude (VS Code) uses for an account, and returns
// the one named before.
async function setProfile(dir, name) {
  const profiles = { ...(settings.get().vscodeProfiles || {}) };
  const key = Object.keys(profiles).find((k) => k && claudeDirs.same(k, dir)) || dir;
  const before = profiles[key] || '';
  if (name) profiles[key] = name;
  else delete profiles[key];
  settings.update({ vscodeProfiles: profiles });
  return before;
}

// The context each task is given: the apps, the accounts and the settings.
const context = () => ({
  vscode,
  accounts: claudeDirs.list().slice(1),
  chosenProfiles: settings.get().vscodeProfiles || {},
  setProfile,
});

// The tasks that apply to this computer, each with its items' state and
// steps, and whether each can be undone.
function list() {
  const r = records();
  return Object.values(TASKS)
    .map((t) => t.check(context()))
    .filter(Boolean)
    .map((t) => ({ ...t, items: t.items.map((i) => ({ ...i, canUndo: recordKey(t.id, i.key) in r })) }));
}

let busy = false;

// Runs one item's Apply or Undo, one at a time.
async function run(taskId, key, action) {
  const task = TASKS[taskId];
  const item = task && list().find((t) => t.id === taskId)?.items.find((i) => i.key === key);
  if (!item) return { ok: false, error: "That isn't something the assistant can do here now." };
  if (busy) return { ok: false, error: 'The assistant is already doing something. Wait for it to finish.' };
  busy = true;
  try {
    const all = records();
    const k = recordKey(taskId, key);
    if (action === 'undo') {
      if (!all[k]) return { ok: false, error: 'There is nothing to undo for that.' };
      const result = await task.undo(key, { ...context(), record: all[k] });
      if (result.ok) {
        delete all[k];
        saveRecords(all);
      }
      return result;
    }
    // A second Apply keeps what the first needs to undo.
    const record = { ...(all[k] || {}) };
    const result = await task.apply(key, { ...context(), record });
    if (Object.keys(record).length) saveRecords({ ...records(), [k]: record });
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    busy = false;
  }
}

module.exports = { list, run };
