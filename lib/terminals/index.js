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
//   close(pid)             ends the session, and its terminal tab with it
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
// setting, so it stays. Claude Code also turns colour off for what it runs
// (NO_COLOR=1), which would leave the sessions' tabs black and white. Done once, as this module loads, for everything
// that opens terminals.
//
// Codex gives the commands it runs its session's IDs and sandbox, and turns
// off colour and paging for them, which would carry into the tabs too. The
// settings people set themselves, such as CODEX_HOME, stay.
const CODEX_SESSION_VARS = /^CODEX_(THREAD_ID|SESSION_ID|TOOL_CALL_ID|VERSION|PERMISSION_PROFILE|SANDBOX\w*|CI|APPLY_PATCH_\w+|NETWORK_PROXY_\w+)$/;
const CODEX_PLAIN_OUTPUT = { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', GH_PAGER: 'cat' };
// The Copilot CLI's own, for its session, hooks and supervisor. COPILOT_HOME
// and a GitHub token someone set themselves stay.
const COPILOT_SESSION_VARS = /^COPILOT_(CLI|AGENT_SESSION_ID|PROJECT_DIR|HOOK_\w+|TRACEPARENT|PLUGIN_ROOT|LOADER_PID|SUPERVISED|RESTART_SUPERVISOR\w*|CONNECTION_TOKEN|DETACHED_\w+)$/;

function forgetParentSession(env = process.env) {
  const insideCodex = 'CODEX_THREAD_ID' in env;
  const insideClaude = env.CLAUDECODE === '1';
  if (insideClaude && env.NO_COLOR === '1') delete env.NO_COLOR;
  for (const key of Object.keys(env)) {
    if (/^CLAUDE(CODE$|_)/.test(key) && key !== 'CLAUDE_CONFIG_DIR') delete env[key];
    else if (CODEX_SESSION_VARS.test(key) || COPILOT_SESSION_VARS.test(key)) delete env[key];
    else if (insideCodex && CODEX_PLAIN_OUTPUT[key] === env[key]) delete env[key];
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

// A command run with an environment variable set, in the shell tabs run
// commands in: PowerShell on Windows, a POSIX shell elsewhere. In PowerShell
// it stays set in that tab.
function withEnv(name, value, command) {
  return driver.name === 'windows' ? `$env:${name} = ${driver.quote(value)}; ${command}` : `${name}=${driver.quote(value)} ${command}`;
}

module.exports = { ...driver, pickFolder, forgetParentSession, withEnv };
