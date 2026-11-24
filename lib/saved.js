'use strict';

const store = require('./store');

// The set of sessions Save and close saved last, for Resume last session to
// open again. Saved as saved-sessions.json. Each is what's needed to resume
// it: its app, ID and folder, and a name to show.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clean(s) {
  if (!s || !UUID.test(s.id) || typeof s.cwd !== 'string' || !['claude', 'codex'].includes(s.app)) return null;
  return { app: s.app, id: s.id, cwd: s.cwd, name: typeof s.name === 'string' ? s.name.slice(0, 300) : null };
}

function load() {
  const saved = store.read('saved-sessions', null);
  if (!saved || !Number.isFinite(saved.savedAt) || !Array.isArray(saved.sessions)) return null;
  return { savedAt: saved.savedAt, sessions: saved.sessions.map(clean).filter(Boolean) };
}

let saved = load();

// Replaces the saved set with these sessions.
function save(sessions, now = Date.now()) {
  const next = { savedAt: now, sessions: sessions.map(clean).filter(Boolean) };
  store.write('saved-sessions', next);
  saved = next;
  return saved;
}

const get = () => saved;

module.exports = { save, get };
