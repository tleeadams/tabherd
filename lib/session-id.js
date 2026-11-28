'use strict';

// A session's ID as the apps make them: a UUID (Claude, Codex, Copilot,
// Cursor), or OpenCode's ses_… Either is safe in a command line as it is.
const SESSION_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ses_[A-Za-z0-9]{10,60})$/i;

const isSessionId = (id) => typeof id === 'string' && SESSION_ID.test(id);

module.exports = { isSessionId };
