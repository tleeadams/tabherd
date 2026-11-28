'use strict';

// Starting Claude Code in VS Code, through the Claude Code extension, in
// place of a terminal tab. VS Code opens the folder, then the extension's
// link, vscode://anthropic.claude-code/open?prompt=…, opens a Claude tab in
// that window with the prompt filled in, for you to send. The extension picks
// the session's ID itself, so a to-do is linked to the first session it
// starts in the to-do's folder.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const terminals = require('./terminals');

const IS_WIN = process.platform === 'win32';
// How long a to-do waits for its session to start: the prompt waits for you.
const EXPECT_MS = 30 * 60 * 1000;
const FOUND_MS = 30000;

// VS Code's command-line tool, as [program, ...args] plus its environment.
// On Windows, `code` is a batch file, which would need a shell and its
// quoting; it runs Code.exe as Node on VS Code's cli.js, so that's run
// directly. Elsewhere `code` is a script that execFile can run.
function findCli(env = process.env) {
  const names = IS_WIN ? ['code.cmd'] : ['code'];
  const dirs = [
    ...(env.PATH || '').split(path.delimiter),
    IS_WIN && env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin'),
    IS_WIN && env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft VS Code', 'bin'),
    process.platform === 'darwin' && '/Applications/Visual Studio Code.app/Contents/Resources/app/bin',
  ].filter(Boolean);
  for (const dir of dirs) {
    for (const n of names) {
      const file = path.join(dir, n);
      if (!fs.existsSync(file)) continue;
      if (!IS_WIN) return { cmd: file, args: [], env: {} };
      // "%~dp0..\Code.exe" "%~dp0..\<commit>\resources\app\out\cli.js" %*
      const script = fs.readFileSync(file, 'utf8');
      const m = script.match(/"%~dp0([^"]+\.exe)"\s+"%~dp0([^"]+cli\.js)"/i);
      if (!m) continue;
      const exe = path.resolve(dir, m[1]);
      const cli = path.resolve(dir, m[2]);
      if (fs.existsSync(exe) && fs.existsSync(cli)) return { cmd: exe, args: [cli], env: { ELECTRON_RUN_AS_NODE: '1' } };
    }
  }
  return null;
}

// Whether the Claude Code extension is installed in VS Code.
function hasExtension(home = os.homedir()) {
  try {
    return fs.readdirSync(path.join(home, '.vscode', 'extensions')).some((n) => /^anthropic\.claude-code-\d/.test(n));
  } catch {
    return false;
  }
}

let found = null;
let foundAt = 0;

function cli() {
  if (Date.now() - foundAt > FOUND_MS) {
    found = findCli();
    if (found && !hasExtension()) found = null;
    foundAt = Date.now();
  }
  return found;
}

// Whether VS Code and its Claude Code extension are both installed.
const installed = () => Boolean(cli());

// Runs VS Code's command-line tool. VS Code may start from it, so it gets the
// environment a terminal tab would: none of a Claude Code session's own, and
// `extra`, such as the Claude account.
function run(c, args, extra = {}, timeout = 30000) {
  const env = { ...terminals.forgetParentSession({ ...process.env }), ...extra, ...c.env };
  return new Promise((resolve) => {
    execFile(c.cmd, [...c.args, ...args], { env, windowsHide: true, timeout }, (err, stdout, stderr) =>
      resolve(err ? { ok: false, error: String(stderr || err.message).trim().split('\n')[0] } : { ok: true }),
    );
  });
}

// Whether VS Code is running, when its command-line tool only passes what it's
// given to the VS Code already open, environment and all.
function isRunning() {
  const [cmd, args] = IS_WIN
    ? ['tasklist', ['/FI', 'IMAGENAME eq Code.exe', '/FO', 'CSV', '/NH']]
    : ['pgrep', ['-f', process.platform === 'darwin' ? 'Visual Studio Code.app/Contents/MacOS' : '/code( |$)']];
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10000 }, (err, stdout) => resolve(IS_WIN ? /"Code\.exe"/i.test(String(stdout)) : !err && Boolean(String(stdout).trim())));
  });
}

// The extension's link for a new Claude tab with this prompt filled in.
const claudeLink = (prompt) => `vscode://anthropic.claude-code/open${prompt ? `?${new URLSearchParams({ prompt })}` : ''}`;

// Opens the folder in VS Code (its window, if it has one), then a new Claude
// tab there with the prompt filled in.
//
// The extension signs in with the Claude account in VS Code's environment, so
// `claudeDir` (the account, null for the default) only takes when VS Code
// starts here. A VS Code profile can name its own account in its settings
// (claudeCode.environmentVariables), so with `profile` the folder opens in it
// and the account is the profile's. Otherwise, with VS Code already open on
// another account, the result has a `note` saying so.
async function startClaude(cwd, prompt = '', { claudeDir = null, account = '', profile = '' } = {}) {
  const c = cli();
  if (!c) return { ok: false, error: "VS Code with the Claude Code extension isn't installed on this computer." };
  let note = null;
  let env = {};
  if (!profile && claudeDir) {
    if (await isRunning()) {
      note = `VS Code was already open, so Claude there uses the account VS Code started with, which may not be ${account}. Quit VS Code first, or give ${account} a VS Code profile in Settings → Claude accounts.`;
    } else env = { CLAUDE_CONFIG_DIR: claudeDir };
  }
  const opened = await run(c, profile ? ['--profile', profile, cwd] : [cwd], env);
  if (!opened.ok) return { ok: false, error: `Couldn't open VS Code: ${opened.error}` };
  const linked = await run(c, ['--open-url', claudeLink(prompt)]);
  if (!linked.ok) return { ok: false, error: `Couldn't open Claude in VS Code: ${linked.error}` };
  return { ok: true, note };
}

// ---- linking to-dos ----------------------------------------------------------------

// To-dos started in VS Code, each waiting for the first Claude session VS Code
// starts in its folder after it.
let expected = [];
const same = (a, b) => (IS_WIN ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

function expect(cwd, then, now = Date.now()) {
  expected.push({ cwd, at: now, then });
}

// Links waiting to-dos to the sessions now running. Each session goes to one
// to-do at most, and `taken(id)` says which already have one.
function settle(agents, { now = Date.now(), taken = () => false } = {}) {
  if (!expected.length) return;
  expected = expected.filter((e) => now - e.at < EXPECT_MS);
  for (const e of [...expected]) {
    const a = agents
      .filter((x) => x.app === 'claude' && x.entrypoint === 'claude-vscode' && x.cwd && same(x.cwd, e.cwd) && (x.startedAt || 0) >= e.at - 2000 && !taken(x.id))
      .sort((x, y) => x.startedAt - y.startedAt)[0];
    if (!a) continue;
    expected = expected.filter((x) => x !== e);
    e.then(a.id);
  }
}

// Runs VS Code's command-line tool with these arguments, for the Config
// Assistant.
async function code(args, { timeout } = {}) {
  const c = cli();
  if (!c) return { ok: false, error: "VS Code with the Claude Code extension isn't installed on this computer." };
  return run(c, args, {}, timeout);
}

module.exports = { installed, code, startClaude, expect, settle, findCli, hasExtension, claudeLink };
