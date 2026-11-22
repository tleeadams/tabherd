'use strict';

// Everything that drives terminals and windows, one driver per operating
// system, each with the same functions:
//
//   terminals()            the terminals Settings offers, and which are available
//   quote(text)            text quoted as one argument for the shell commands run in
//   open(dir, command, o)  opens a tab running `command` in `dir`, in o.terminal
//   focus(pid, o)          goes to the session's tab; with o.send, also types
//                          that prompt into it and presses Enter
//   pickFolder(start, t)   shows a folder picker: { ok, path } or { ok, cancelled }
//   stop(pid)              ends the session and the processes it started
//   openFolder(dir)        shows the folder in the file manager
//   refreshTitles(pids)    starts reading the sessions' tab titles, in the background
//   titleFor(pid)          the title last read for that session's tab

const DRIVERS = { win32: './windows', darwin: './macos', linux: './linux' };
const driver = require(DRIVERS[process.platform] || './unsupported');

// The variables a Claude Code session gives the programs it runs. A server
// started from inside a session has them, and the terminals it opens pass
// them on, so the sessions it starts would run as that one's children:
// unattended, without colour, unseen by the dashboard, and holding that
// session's messaging pipe and token. CLAUDE_CONFIG_DIR is the user's own
// setting, so it stays. Done once, as this module loads, for everything
// that opens terminals.
function forgetParentSession(env = process.env) {
  for (const key of Object.keys(env)) {
    if (/^CLAUDE(CODE$|_)/.test(key) && key !== 'CLAUDE_CONFIG_DIR') delete env[key];
  }
  return env;
}
forgetParentSession();

// One picker at a time: a second one would open behind the first.
let picking = false;

async function pickFolder(start, title) {
  if (picking) return { ok: false, error: 'A folder picker is already open. It may be behind another window.' };
  picking = true;
  try {
    return await driver.pickFolder(start, title);
  } finally {
    picking = false;
  }
}

module.exports = { ...driver, pickFolder, forgetParentSession };
