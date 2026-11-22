'use strict';

// Windows: sessions run in Windows Terminal (or VS Code, or a classic
// console). PowerShell scripts beside this file do the work that needs the
// Windows API: finding and focusing a session's tab, typing into its console,
// reading tab titles and showing the folder picker.

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const titles = require('./windows-titles');

const FOCUS_SCRIPT = path.join(__dirname, 'windows-focus.ps1');
const PICK_SCRIPT = path.join(__dirname, 'windows-pick-folder.ps1');

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// pwsh from the Microsoft Store is an app execution alias, a link that
// fs.existsSync can't follow, so check for the link itself.
function onPath(exe) {
  return (process.env.PATH || '').split(path.delimiter).some((dir) => {
    try {
      return Boolean(dir) && Boolean(fs.lstatSync(path.join(dir, exe)));
    } catch {
      return false;
    }
  });
}

// The script's last line of output is its JSON result.
function lastJsonLine(stdout, stderr, err, fallback) {
  try {
    return JSON.parse(String(stdout).trim().split(/\r?\n/).pop());
  } catch {
    const detail = String(stderr || err?.message || '').trim().split(/\r?\n/)[0];
    return { ok: false, error: detail || fallback };
  }
}

// Goes to the session's window and, with `send`, also types that prompt into
// it. `statusFile` is the session's registry file: nothing is typed while it
// says the session is waiting on a prompt or dialog.
function focus(pid, { send, statusFile } = {}) {
  return new Promise((resolve) => {
    const extra = send ? ` -Send ${psQuote(send)} -StatusFile ${psQuote(statusFile)}` : '';
    // An encoded command isn't subject to the script execution policy.
    const script = `& {\n${fs.readFileSync(FOCUS_SCRIPT, 'utf8')}\n} ${Number(pid)}${extra}`;
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    execFile('powershell.exe', args, { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
      const result = lastJsonLine(stdout, stderr, err, 'Could not find the window.');
      if (result.tabName) titles.remember(pid, result.hwnd, result.tabName);
      resolve(result);
    });
  });
}

const TERMINAL_SETTINGS = [
  ['Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'],
  ['Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'],
  ['Microsoft', 'Windows Terminal', 'settings.json'],
];

// Windows Terminal's profile defaults can say to run tabs as administrator. A
// tab opened with just a command line gets those defaults, so it opened in a
// separate administrator instance that also mangled the command. Naming the
// default profile gives the tab the settings the user's own new tabs get.
function defaultTerminalProfile() {
  for (const parts of TERMINAL_SETTINGS) {
    try {
      const text = fs.readFileSync(path.join(process.env.LOCALAPPDATA || '', ...parts), 'utf8');
      const match = text.match(/"defaultProfile"\s*:\s*"([^"]+)"/);
      if (match) return match[1];
    } catch {}
  }
  return null;
}

// Opens a tab in the most recently used Windows Terminal window, running
// `command` in `dir`. It runs inside a shell, so the tab stays open at a
// prompt in that folder after it exits.
function open(dir, command) {
  return new Promise((resolve) => {
    // Windows Terminal reads a semicolon anywhere in its arguments as the start
    // of another command.
    if (dir.includes(';')) {
      resolve({ ok: false, error: "Windows Terminal can't open a folder with a semicolon in its path." });
      return;
    }
    const shell = onPath('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe';
    const profile = defaultTerminalProfile();
    // Encoded, the command can't be split up or have its flags read by
    // Windows Terminal as its own.
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    const args = ['-w', '0', 'new-tab', ...(profile ? ['-p', profile] : []), '-d', dir, shell, '-NoExit', '-EncodedCommand', encoded];
    const child = spawn('wt.exe', args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => resolve({ ok: false, error: `Couldn't start Windows Terminal: ${err.message}` }));
    child.on('spawn', () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

// Shows Windows' folder picker, in front of the other windows, and resolves to
// { ok, path } or { ok, cancelled }.
function pickFolder(start, title) {
  return new Promise((resolve) => {
    // pwsh has the newer dialog, with the address bar and the folder to start in.
    const shell = onPath('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe';
    const script = `& {\n${fs.readFileSync(PICK_SCRIPT, 'utf8')}\n}`;
    const args = ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    const env = { ...process.env, AGENTS_PICK_START: start || '', AGENTS_PICK_TITLE: title || '' };
    execFile(shell, args, { windowsHide: true, env, timeout: 30 * 60 * 1000 }, (err, stdout, stderr) => {
      resolve(lastJsonLine(stdout, stderr, err, "The folder picker didn't open."));
    });
  });
}

// /T also ends the session's shells and MCP servers; a console app ignores a
// polite close request, so /F is needed.
function stop(pid) {
  return new Promise((resolve) => {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: out.trim() || `taskkill exited ${code}` }));
  });
}

function openFolder(dir) {
  const child = spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

// Only Windows Terminal, for now.
const TERMINALS = [{ id: 'windows-terminal', name: 'Windows Terminal' }];

module.exports = {
  name: 'windows',
  terminals: () => TERMINALS.map((t) => ({ ...t, available: true })),
  // Commands run in PowerShell.
  quote: psQuote,
  open,
  focus,
  pickFolder,
  stop,
  openFolder,
  refreshTitles: titles.refresh,
  titleFor: titles.titleFor,
};
