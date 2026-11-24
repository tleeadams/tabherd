'use strict';

// Codex sessions, as cards like Claude's. Which sessions are open, and
// whether each is working, idle or waiting for you, come from Codex's
// background service (codex-client.js); what they last did comes from their
// session files (codex-rollout.js). Codex records no process for a session,
// so its terminal window is found by its tab's title, which Codex sets to the
// session's name.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { CodexClient, mapStatus, serviceRunning, CODEX_HOME } = require('./codex-client');
const { Rollout } = require('./codex-rollout');
const terminals = require('./terminals');

const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const NAMES_FILE = path.join(CODEX_HOME, 'session_index.jsonl');
const IS_WIN = process.platform === 'win32';
const WINDOWS_REFRESH_MS = 10000;
const NO_SUBAGENTS = { running: [], finished: [], finishedTotal: 0 };
const ROLLOUT_FILE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
// `codex <command>`s that aren't a session in a terminal.
const NOT_A_SESSION = new Set(
  'exec e login logout mcp mcp-server app-server completion sandbox debug apply a cloud features queue archive unarchive delete help update agents doctor migrate-rollouts exec-server responses-api-proxy stdio-to-uds generate-ts'.split(' '),
);

const client = new CodexClient();
const rollouts = new Map();
const rolloutPaths = new Map();
let windows = [];
let windowsAt = 0;
let windowsPending = null;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err && !stdout ? null : String(stdout)),
    );
  });
}

// Whether a process is Codex in a terminal: the `codex` program (named for
// its platform when installed by winget), running no other command.
function isSessionWindow(name, args) {
  if (!/^codex(-(x86_64|aarch64|arm64)[\w.-]*)?(\.exe)?$/i.test(name)) return false;
  const first = args.find((a) => !a.startsWith('-'));
  return !first || !NOT_A_SESSION.has(first);
}

// The `codex` processes running in terminals: [{ pid, memBytes }].
async function findWindows() {
  const found = [];
  if (IS_WIN) {
    const script =
      `Get-CimInstance Win32_Process -Filter "Name like 'codex%'" | ForEach-Object { ` +
      `'{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.Name, $_.WorkingSetSize, $_.CommandLine }`;
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (out === null) return null;
    for (const line of out.split(/\r?\n/)) {
      const [pid, name, ws, ...cmd] = line.trim().split('|');
      if (!pid) continue;
      const args = cmd.join('|').replace(/^\s*("[^"]*"|\S+)\s*/, '').split(/\s+/).filter(Boolean);
      if (isSessionWindow(name, args)) found.push({ pid: Number(pid), memBytes: Number(ws) || null });
    }
  } else {
    const out = await run('ps', ['-A', '-o', 'pid=,rss=,args=']);
    if (out === null) return null;
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
      if (m && isSessionWindow(path.basename(m[3]), m[4].split(/\s+/).filter(Boolean))) {
        found.push({ pid: Number(m[1]), memBytes: Number(m[2]) * 1024 });
      }
    }
  }
  return found;
}

function refreshWindows() {
  if (windowsPending || Date.now() - windowsAt < WINDOWS_REFRESH_MS) return;
  windowsPending = findWindows().then((found) => {
    if (found) {
      windows = found;
      windowsAt = Date.now();
    }
    windowsPending = null;
  });
}

// The parts of a Codex tab's title: its session's name and project, after
// a spinner or "Action Required" while it works or waits.
const titleParts = (title) =>
  String(title || '')
    .split(' | ')
    .map((p) => p.replace(/^[⠀-⣿]\s*/, '').trim())
    .filter(Boolean);

// Each session's window, by its name in a tab's title. A session that isn't
// named yet goes with the only window left, if there's one.
function matchWindows(threads, wins, titleFor = terminals.titleFor) {
  const byThread = new Map();
  const free = new Map(wins.map((w) => [w.pid, w]));
  for (const t of threads) {
    if (!t.name) continue;
    const matches = [...free.values()].filter((w) => titleParts(titleFor(w.pid)).includes(t.name));
    if (matches.length !== 1) continue;
    byThread.set(t.id, matches[0]);
    free.delete(matches[0].pid);
  }
  const left = threads.filter((t) => !byThread.has(t.id));
  if (left.length === 1 && free.size === 1) byThread.set(left[0].id, [...free.values()][0]);
  return byThread;
}

// A session's file, from the service or else its folder for the day it began.
// Codex creates it at the first prompt, so a new session has none yet.
function findRollout(t) {
  if (t.path && fs.existsSync(t.path)) return t.path;
  const cached = rolloutPaths.get(t.id);
  if (cached && fs.existsSync(cached)) return cached;
  const began = t.createdAt ? new Date(t.createdAt * 1000) : new Date();
  for (const offset of [0, 1, -1]) {
    const d = new Date(began.getTime() + offset * 86400000);
    const dir = path.join(SESSIONS_DIR, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const name = names.find((n) => n.endsWith(`-${t.id}.jsonl`));
    if (name) {
      rolloutPaths.set(t.id, path.join(dir, name));
      return path.join(dir, name);
    }
  }
  return null;
}

function readRollout(file, used) {
  let r = rollouts.get(file);
  if (!r) {
    r = new Rollout(file);
    rollouts.set(file, r);
  }
  used.add(file);
  return r.update() ? r : null;
}

// A session in a terminal, not a subagent's or one run by `codex exec`.
function isInteractive(t) {
  if (t.parentThreadId || t.ephemeral) return false;
  const source = typeof t.source === 'string' ? t.source : t.source ? 'subagent' : null;
  return !['exec', 'mcp', 'subagent'].includes(source);
}

// Codex sessions as dashboard agents, and the PIDs of their windows, whose
// tab titles the next snapshot needs.
function snapshot() {
  const threads = client.poll().filter(isInteractive);
  refreshWindows();
  const byThread = matchWindows(threads, windows);
  const used = new Set();
  const agents = [];
  for (const t of threads) {
    const state = mapStatus(t.status);
    if (!state) continue;
    const file = findRollout(t);
    const r = file ? readRollout(file, used) : null;
    const win = byThread.get(t.id);
    agents.push({
      ...(r ? r.summary() : {}),
      app: 'codex',
      id: t.id,
      pid: win?.pid ?? null,
      // Codex names a session from its first prompt, or as renamed.
      title: t.name || null,
      name: t.name || path.basename(t.cwd || '') || 'Codex',
      cwd: t.cwd,
      kind: 'interactive',
      entrypoint: 'cli',
      version: r?.s.version || null,
      status: state.status,
      waitingFor: state.waitingFor,
      detail: state.detail || null,
      statusSince: t.statusSince,
      startedAt: t.createdAt ? t.createdAt * 1000 : null,
      memBytes: win?.memBytes ?? null,
      terminalTitle: null,
      subagents: NO_SUBAGENTS,
    });
  }
  for (const file of rollouts.keys()) if (!used.has(file)) rollouts.delete(file);
  return { agents, windowPids: windows.map((w) => w.pid) };
}

// ---- history -----------------------------------------------------------------

// Whether the open sessions are known: the service has answered, or isn't running.
const settled = () => client.ready || !serviceRunning();

// Session names, from the file Codex appends one to whenever a session is
// named or renamed. The last one for each session wins.
function sessionNames() {
  const names = new Map();
  let text;
  try {
    text = fs.readFileSync(NAMES_FILE, 'utf8');
  } catch {
    return names;
  }
  for (const line of text.split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e.id) names.set(e.id, e.thread_name || null);
    } catch {}
  }
  return names;
}

// Session files changed since `floor` (ms): [{ id, file, mtime }], newest day
// first. Ones Codex has compressed (.jsonl.zst, after a week) are left out.
async function sessionFiles(floor) {
  const files = [];
  const list = async (dir) => {
    try {
      return (await fs.promises.readdir(dir)).sort().reverse();
    } catch {
      return [];
    }
  };
  const floorDay = new Date(floor);
  floorDay.setHours(0, 0, 0, 0);
  for (const y of await list(SESSIONS_DIR)) {
    if (Number(y) < floorDay.getFullYear()) continue;
    for (const m of await list(path.join(SESSIONS_DIR, y))) {
      for (const d of await list(path.join(SESSIONS_DIR, y, m))) {
        if (new Date(Number(y), Number(m) - 1, Number(d)) < floorDay) continue;
        const dir = path.join(SESSIONS_DIR, y, m, d);
        for (const name of await list(dir)) {
          const id = name.match(ROLLOUT_FILE)?.[1];
          if (!id) continue;
          const file = path.join(dir, name);
          try {
            const mtime = (await fs.promises.stat(file)).mtimeMs;
            if (mtime >= floor) files.push({ id, file, mtime });
          } catch {}
        }
      }
    }
  }
  return files;
}

module.exports = { snapshot, settled, sessionNames, sessionFiles, isSessionWindow, matchWindows, titleParts, client, SESSIONS_DIR };
