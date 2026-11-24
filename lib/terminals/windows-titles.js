'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'windows-titles.ps1');
const REFRESH_MS = 3000;
const TIMEOUT_MS = 15000;

// pid -> { title, window, tab }. A renamed tab only shows whose it is while
// selected, so what was learned is kept until the tab or session goes away.
const known = new Map();
let worker = null;
let pending = null;
let lastScanAt = 0;

const titleKey = (title) => String(title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();

function startWorker() {
  const script = fs.readFileSync(SCRIPT, 'utf8');
  // An encoded command isn't subject to the script execution policy.
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  // It doesn't keep Node running by itself: the server does that, and a
  // one-off run, such as --once, can exit.
  child.unref();
  child.stdin.unref?.();
  child.stdout.unref?.();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!pending) continue;
      const { resolve, timer } = pending;
      pending = null;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve(null);
      }
    }
  });
  const reset = () => {
    if (worker === child) worker = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(null);
      pending = null;
    }
  };
  child.on('exit', reset);
  child.on('error', reset);
  child.stdin.on('error', reset);
  return child;
}

function scan(pids) {
  if (!worker) worker = startWorker();
  const child = worker;
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    pending = { resolve, timer };
    child.stdin.write(`${pids.join(' ')}\n`);
  });
}

function merge(result, pids) {
  const live = new Set(pids.map(String));
  for (const pid of known.keys()) if (!live.has(pid)) known.delete(pid);
  const windows = result.windows || {};
  for (const [pid, s] of Object.entries(result.sessions || {})) {
    const prev = known.get(pid);
    const entry = { title: s.title || '', window: s.window || null, tab: s.tab || null };
    if (!entry.tab && prev?.tab && prev.window === entry.window && windows[entry.window]?.includes(prev.tab)) {
      entry.tab = prev.tab;
    }
    known.set(pid, entry);
  }
  // In a window where one session's tab is unknown and exactly one tab isn't
  // claimed by another session, that tab must be the one.
  for (const [win, tabs] of Object.entries(windows)) {
    const entries = [...known.values()].filter((e) => e.window === win);
    const unknown = entries.filter((e) => !e.tab);
    const claimed = new Set(entries.filter((e) => e.tab).map((e) => e.tab));
    const free = tabs.filter((t) => !claimed.has(t));
    if (unknown.length === 1 && free.length === 1) unknown[0].tab = free[0];
  }
}

// Starts a background scan when the last one is stale. Never waits for it;
// the next snapshot picks up the result.
function refresh(pids) {
  if (process.platform !== 'win32' || pending || Date.now() - lastScanAt < REFRESH_MS || !pids.length) return;
  lastScanAt = Date.now();
  scan(pids).then((result) => {
    if (result) merge(result, pids);
  });
}

// Records the tab that Go to window found.
function remember(pid, window, tab) {
  const entry = known.get(String(pid));
  if (entry && tab && (!entry.window || entry.window === String(window))) {
    entry.window = String(window);
    entry.tab = tab;
  }
}

// What the terminal shows for this session: a renamed tab's name, otherwise
// the session's own title without Claude Code's spinner glyph.
function titleFor(pid) {
  const entry = known.get(String(pid));
  if (!entry) return null;
  if (entry.tab && titleKey(entry.tab) !== entry.title) return entry.tab;
  return entry.title || null;
}

module.exports = { refresh, remember, titleFor };
