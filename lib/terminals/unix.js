'use strict';

// What macOS and Linux share: the process table, a session's terminal device
// and the processes above it, ending a process tree, and running the
// command-line tools that drive terminals.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

// Runs a command and resolves to { ok, code, stdout, stderr }; never rejects.
// With TABHERD_DEBUG set, each command that fails is logged with its output.
function run(cmd, args, { timeout = 10000, env, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const result = { ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout), stderr: String(stderr || err?.message || '') };
      if (!result.ok && process.env.TABHERD_DEBUG) {
        console.error(`[debug] ${cmd} ${args.map((a) => JSON.stringify(a).slice(0, 120)).join(' ')}\n[debug]   exit ${result.code}: ${result.stderr.trim().slice(0, 500)}`);
      }
      resolve(result);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// The full path of a command on the PATH, or null.
function which(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, cmd);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

function detached(cmd, args, { env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env });
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('spawn', () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

// Every process: pid -> { pid, ppid, tty, name }. `tty` is a device path such
// as /dev/ttys003 or /dev/pts/3, or null for a process with no terminal.
async function processTable() {
  const out = await run('ps', ['-A', '-o', 'pid=,ppid=,tty=,comm=']);
  const table = new Map();
  for (const line of out.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const tty = m[3] === '?' || m[3] === '??' || m[3] === '-' ? null : `/dev/${m[3]}`;
    table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), tty, name: path.basename(m[4].trim()) });
  }
  return table;
}

// The process and its ancestors, nearest first.
function ancestors(table, pid) {
  const chain = [];
  const seen = new Set();
  for (let p = table.get(pid); p && !seen.has(p.pid); p = table.get(p.ppid)) {
    seen.add(p.pid);
    chain.push(p);
  }
  return chain;
}

function descendants(table, pid) {
  const children = new Map();
  for (const p of table.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const found = [];
  const queue = [...(children.get(pid) || [])];
  while (queue.length) {
    const next = queue.shift();
    if (found.includes(next)) continue;
    found.push(next);
    queue.push(...(children.get(next) || []));
  }
  return found;
}

// A process's environment. Linux only: macOS doesn't let one process read
// another's, so there it's null.
function environment(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    const env = {};
    for (const entry of raw.split('\0')) {
      const at = entry.indexOf('=');
      if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
    }
    return env;
  } catch {
    return null;
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// Ends the session and everything it started, such as its shells and MCP
// servers: asked politely first, then forced after two seconds, as Stop on
// Windows forces it.
async function stop(pid) {
  const table = await processTable();
  if (!table.has(pid)) return { ok: false, error: 'That process has already ended.' };
  const tree = [pid, ...descendants(table, pid)];
  for (const p of tree.slice().reverse()) {
    try {
      process.kill(p, 'SIGTERM');
    } catch {}
  }
  for (let waited = 0; waited < 2000 && tree.some(alive); waited += 100) await new Promise((r) => setTimeout(r, 100));
  for (const p of tree.filter(alive)) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {}
  }
  if (alive(pid)) return { ok: false, error: `PID ${pid} didn't end.` };
  return { ok: true };
}

// Shells, by the name ps gives them; a login shell's starts with a dash.
const SHELLS = /^-?(bash|zsh|fish|sh|dash|ksh|mksh|tcsh|csh|nu|elvish|xonsh)$/;

// Ends the session as Stop does, then the shell it ran in, if it ran in one,
// so the terminal closes that tab or pane, or tmux that pane.
async function close(pid) {
  const table = await processTable();
  const self = table.get(pid);
  const shell = self && table.get(self.ppid);
  const result = await stop(pid);
  if (!result.ok) return result;
  if (!shell || !SHELLS.test(shell.name)) return { ok: true, closedTab: false };
  try {
    process.kill(shell.pid, 'SIGHUP');
  } catch {}
  return { ok: true, closedTab: true };
}

// Single-quoted for a POSIX shell.
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The command line a new tab runs: `command` in `dir`, then the user's own
// shell, so the tab stays open at a prompt there after the command ends.
function shellLine(dir, command) {
  return `cd ${shQuote(dir)} && ${command}; exec "\${SHELL:-/bin/sh}" -l`;
}

// That line run by the user's shell as an interactive login shell, which
// reads the files where `claude` is usually put on the PATH.
const userShell = () => process.env.SHELL || '/bin/bash';
const shellArgs = (dir, command) => [userShell(), '-lic', shellLine(dir, command)];
const shellCommand = (dir, command) => shellArgs(dir, command).map(shQuote).join(' ');

// The title Claude Code shows, without the spinner or status glyph in front.
const titleKey = (title) => String(title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();

// Whether a unix socket is at that path.
function isSocket(file) {
  try {
    return fs.statSync(file).isSocket();
  } catch {
    return false;
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  close,
  run,
  which,
  detached,
  processTable,
  ancestors,
  descendants,
  environment,
  alive,
  stop,
  shQuote,
  shellLine,
  shellArgs,
  shellCommand,
  titleKey,
  isSocket,
  pause,
};
