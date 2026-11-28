'use strict';

// Google Antigravity's command-line agent (agy), as cards like Claude's. It
// keeps its state in ~/.gemini/antigravity-cli:
//
//   conversation_summaries.db   each conversation's title, folder, status
//                               (idle, running, busy) and step count
//   conversations/<id>.db       its steps: prompts, replies and tool calls,
//                               as protocol buffers
//   presence/<id>.lock          held while a window has that conversation
//                               open, and left behind after
//
// Both are SQLite, read with Node's own node:sqlite, so Antigravity needs
// Node 22.13 or later; without it there are no Antigravity cards.
//
// agy doesn't set its tab's title, and Windows doesn't show its command
// line, so each window is matched to its conversation by when each began: a
// window has the newest open conversation begun since it started. On Windows,
// a conversation is open while its presence lock is held.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const { execFile } = require('child_process');
const refs = require('./ticket-refs');
const { clip } = require('./transcript');

const IS_WIN = process.platform === 'win32';
const HOME = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const SUMMARIES = path.join(HOME, 'conversation_summaries.db');
const WINDOWS_REFRESH_MS = 3000;
const SUMMARIES_REFRESH_MS = 2000;
// A conversation begun this soon before its window's process was seen to
// start is still that window's: the two clocks are read separately.
const START_SLACK_MS = 2000;
// How long a to-do waits for its conversation to begin.
const EXPECT_MS = 10 * 60 * 1000;
const NO_SUBAGENTS = { running: [], finished: [], finishedTotal: 0 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// agy's commands and flags that aren't a window with a conversation in it.
const NOT_A_SESSION = new Set('acp agent agents changelog help install mcp mic-serve models plugin plugins remote-control update'.split(' '));
const NO_WINDOW = /^--?(p|print|prompt|version|help|h|bg-updater)(=|$)/;

// Its step types and step states, as agy numbers them.
const STEP = { USER_INPUT: 14, PLANNER_RESPONSE: 15, ERROR_MESSAGE: 17, ASK_QUESTION: 138 };
const STATE = { RUNNING: 2, DONE: 3, ERROR: 7, GENERATING: 8, WAITING: 9 };

let sqlite;
// Node's SQLite, if this Node has it.
function hasSqlite() {
  if (sqlite === undefined) {
    try {
      sqlite = require('node:sqlite');
    } catch {
      sqlite = null;
    }
  }
  return Boolean(sqlite);
}

function openDb(file) {
  if (!hasSqlite()) return null;
  try {
    return new sqlite.DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

// ---- protocol buffers ------------------------------------------------------------

// The fields of a protocol buffer message: [[number, value]], where a value
// is a number, or a Buffer for anything length-delimited. null if it isn't one.
function fields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let r = 0;
    let mul = 1;
    for (;;) {
      if (i >= buf.length) throw new Error('short');
      const b = buf[i++];
      r += (b & 0x7f) * mul;
      if (!(b & 0x80)) return r;
      mul *= 128;
    }
  };
  try {
    while (i < buf.length) {
      const key = varint();
      const n = Math.floor(key / 8);
      const wire = key % 8;
      if (!n) return null;
      if (wire === 0) out.push([n, varint()]);
      else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else if (wire === 2) {
        const len = varint();
        if (i + len > buf.length) return null;
        out.push([n, buf.subarray(i, i + len)]);
        i += len;
      } else return null;
    }
  } catch {
    return null;
  }
  return i === buf.length ? out : null;
}

// The values at a path of field numbers, such as [20, 7].
function at(buf, pathTo) {
  let level = [buf];
  for (const n of pathTo) {
    const next = [];
    for (const b of level) for (const [k, v] of (Buffer.isBuffer(b) && fields(b)) || []) if (k === n) next.push(v);
    level = next;
  }
  return level;
}
const text = (buf, pathTo) => {
  const v = at(buf, pathTo).find(Buffer.isBuffer);
  return v ? v.toString('utf8') : '';
};

// ---- a conversation's steps -------------------------------------------------------

// What a tool call is about, from its JSON arguments: Antigravity's own
// summary of it, else its command, file or search.
function describe(json) {
  let a = {};
  try {
    a = JSON.parse(json) || {};
  } catch {}
  const t = String(a.toolSummary || a.CommandLine || a.Path || a.AbsolutePath || a.TargetFile || a.Query || a.Url || '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > 160 ? `${t.slice(0, 159)}…` : t;
}

// A conversation's prompts, replies and tools from its steps, the latest
// step's state, and the tickets its prompts and replies name.
function readSteps(rows) {
  const s = { prompts: 0, firstPrompt: null, lastPrompt: null, lastReply: null, tools: [], last: null, ticketRefs: [] };
  for (const r of rows) {
    const payload = Buffer.from(r.step_payload || []);
    s.last = { type: r.step_type, state: r.status };
    if (r.step_type === STEP.USER_INPUT) {
      const prompt = text(payload, [19, 2]).trim();
      if (!prompt) continue;
      s.prompts++;
      s.lastPrompt = { text: clip(prompt), at: null };
      s.firstPrompt = s.firstPrompt || s.lastPrompt;
      s.tools = [];
      s.ticketRefs.push(...refs.find(prompt, 'prompt'));
    } else if (r.step_type === STEP.PLANNER_RESPONSE) {
      const reply = text(payload, [20, 1]).trim();
      if (reply) {
        s.lastReply = { text: clip(reply), at: null };
        s.ticketRefs.push(...refs.find(reply, 'reply'));
      }
      s.tools = at(payload, [20, 7])
        .filter(Buffer.isBuffer)
        .map((call) => ({ name: text(call, [2]) || 'Tool', detail: describe(text(call, [3])), at: null }));
    }
  }
  return s;
}

// Each conversation's steps, read again only once it's changed.
const stepCache = new Map();

function steps(id, changedAt) {
  const cached = stepCache.get(id);
  if (cached && cached.changedAt === changedAt) return cached.s;
  const db = openDb(path.join(HOME, 'conversations', `${id}.db`));
  if (!db) return cached?.s || null;
  let s;
  try {
    s = readSteps(db.prepare('select step_type, status, step_payload from steps order by idx').all());
  } catch {
    s = cached?.s || null;
  } finally {
    db.close();
  }
  if (s) stepCache.set(id, { changedAt, s });
  return s;
}

// ---- conversations ------------------------------------------------------------------

const when = (t) => (t ? Date.parse(String(t).replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1')) || null : null);

// A conversation's folder, from the first of its workspace addresses.
function folderOf(uris) {
  try {
    const first = JSON.parse(uris)[0];
    return first ? fileURLToPath(first) : null;
  } catch {
    return null;
  }
}

// When a conversation began: its steps file's creation, else its lock's.
function begunAt(id) {
  for (const file of [path.join(HOME, 'conversations', `${id}.db`), path.join(HOME, 'presence', `${id}.lock`)]) {
    try {
      const st = fs.statSync(file);
      return st.birthtimeMs || st.mtimeMs;
    } catch {}
  }
  return null;
}

// Every top-level conversation: [{ id, title, cwd, status, changedAt, inputAt, steps }].
function readConversations() {
  const db = openDb(SUMMARIES);
  if (!db) return null;
  try {
    return db
      .prepare(
        'select conversation_id, title, workspace_uris, status, step_count, last_modified_time, last_user_input_time from conversation_summaries where nesting_depth = 0 and killed = 0',
      )
      .all()
      .filter((r) => UUID.test(r.conversation_id))
      .map((r) => ({
        id: r.conversation_id.toLowerCase(),
        title: r.title || null,
        cwd: folderOf(r.workspace_uris),
        status: r.status,
        steps: r.step_count,
        changedAt: when(r.last_modified_time),
        inputAt: when(r.last_user_input_time),
      }));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// Whether a window has a conversation open, on Windows: agy holds its
// presence lock, so reading the file fails. Elsewhere the lock is advisory
// and can't be seen this way: null.
function isOpen(id) {
  if (!IS_WIN) return null;
  let fd;
  try {
    fd = fs.openSync(path.join(HOME, 'presence', `${id}.lock`), 'r+');
  } catch (err) {
    return err.code === 'EBUSY' || err.code === 'EPERM';
  }
  try {
    fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return false;
  } catch (err) {
    return err.code === 'EBUSY';
  } finally {
    fs.closeSync(fd);
  }
}

let conversations = [];
let conversationsAt = 0;

function refreshConversations(now) {
  if (now - conversationsAt < SUMMARIES_REFRESH_MS) return;
  conversationsAt = now;
  const read = readConversations();
  if (read) conversations = read.map((c) => ({ ...c, begunAt: begunAt(c.id) }));
}

// ---- windows ------------------------------------------------------------------

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? null : String(stdout)));
  });
}

// Whether agy's arguments are a window with a conversation in it.
function isSessionWindow(args) {
  if (args.some((a) => NO_WINDOW.test(a))) return false;
  const first = args.find((a) => !a.startsWith('-'));
  return !first || !NOT_A_SESSION.has(first) || UUID.test(first);
}

// The conversation a window was started on, from its command line.
function resumeArg(args) {
  const at = args.findIndex((a) => ['--conversation', '--resume', '-r'].includes(a));
  const id = at >= 0 ? args[at + 1] : args.find((a) => /^--(conversation|resume)=/.test(a))?.split('=')[1];
  return id && UUID.test(id) ? id.toLowerCase() : null;
}

// The agy processes in windows: [{ pid, memBytes, startedAt, resume }]. Its
// updater and the like run as agy too, started by the window's own.
async function findWindows() {
  const all = [];
  if (IS_WIN) {
    const script =
      `Get-CimInstance Win32_Process -Filter "Name = 'agy.exe'" | ForEach-Object { ` +
      `'{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), $_.CommandLine }`;
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (out === null) return null;
    for (const line of out.split(/\r?\n/)) {
      const [pid, ppid, ws, start, ...cmd] = line.trim().split('|');
      if (!pid) continue;
      const args = cmd.join('|').replace(/^\s*("[^"]*"|\S+)\s*/, '').split(/\s+/).filter(Boolean);
      all.push({ pid: Number(pid), ppid: Number(ppid), memBytes: Number(ws) || null, startedAt: Number(start) || null, args });
    }
  } else {
    const out = await run('ps', ['-A', '-o', 'pid=,ppid=,rss=,etime=,args=']);
    if (out === null) return null;
    const now = Date.now();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
      if (!m || path.basename(m[5]) !== 'agy') continue;
      const ran = elapsed(m[4]);
      all.push({ pid: Number(m[1]), ppid: Number(m[2]), memBytes: Number(m[3]) * 1024, startedAt: ran === null ? null : now - ran, args: m[6].split(/\s+/).filter(Boolean) });
    }
  }
  const pids = new Set(all.map((p) => p.pid));
  return all.filter((p) => !pids.has(p.ppid) && isSessionWindow(p.args)).map(({ pid, memBytes, startedAt, args }) => ({ pid, memBytes, startedAt, resume: resumeArg(args) }));
}

// How long ps says a process has run, [[dd-]hh:]mm:ss, in ms.
function elapsed(t) {
  const m = String(t).match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  return m ? (((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000 : null;
}

let windows = [];
let windowsAt = 0;
let windowsPending = null;

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

// Each window's conversation: the one it was started on, else the newest
// open one begun since it started, the latest window first. `open(id)` says
// whether a conversation is open, or null when that can't be told, when any
// begun since the window started will do. An open conversation left over is
// shown without a window.
function matchWindows(convs, wins, open = isOpen) {
  const byPid = new Map();
  const taken = new Set();
  const openNow = new Map(convs.map((c) => [c.id, open(c.id)]));
  for (const w of wins) {
    const c = w.resume && convs.find((x) => x.id === w.resume);
    if (c) {
      byPid.set(w.pid, c);
      taken.add(c.id);
    }
  }
  const newest = (a, b) => (b.begunAt || 0) - (a.begunAt || 0);
  for (const w of wins.filter((x) => !byPid.has(x.pid)).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))) {
    const c = convs
      .filter((x) => !taken.has(x.id) && openNow.get(x.id) !== false && (!w.startedAt || (x.begunAt || 0) >= w.startedAt - START_SLACK_MS))
      .sort(newest)[0];
    if (c) {
      byPid.set(w.pid, c);
      taken.add(c.id);
    }
  }
  const unmatched = convs.filter((c) => !taken.has(c.id) && openNow.get(c.id) === true);
  return { byPid, unmatched };
}

// ---- cards -----------------------------------------------------------------------------

// A conversation's state: working while it runs, unless its latest step is
// waiting on an approval or asking you something. A turn that ended in an
// error needs you too.
function stateOf(c, s) {
  const last = s?.last;
  const running = /RUNNING|BUSY|CANCELING/.test(c.status || '');
  if (last?.type === STEP.ASK_QUESTION && last.state !== STATE.DONE) return { status: 'waiting', waitingFor: 'Your answer' };
  if (running && last?.state === STATE.WAITING) {
    const tool = s.tools[s.tools.length - 1];
    return { status: 'waiting', waitingFor: tool ? `Approval: ${[tool.name, tool.detail].filter(Boolean).join(' ')}` : 'Approval' };
  }
  if (running) return { status: 'busy', waitingFor: null };
  if (last?.type === STEP.ERROR_MESSAGE || last?.state === STATE.ERROR) return { status: 'waiting', waitingFor: 'Its last turn failed' };
  return { status: 'idle', waitingFor: null };
}

// When each conversation's state began, as first seen.
const since = new Map();

function card(c, w, now) {
  const s = steps(c.id, c.changedAt) || {};
  const st = stateOf(c, s);
  const key = `${st.status}:${st.waitingFor}`;
  if (since.get(c.id)?.key !== key) since.set(c.id, { key, at: now });
  return {
    app: 'antigravity',
    id: c.id,
    pid: w?.pid ?? null,
    title: c.title,
    name: c.title || path.basename(c.cwd || '') || 'Antigravity',
    cwd: c.cwd,
    kind: 'interactive',
    entrypoint: 'cli',
    status: st.status,
    waitingFor: st.waitingFor,
    statusSince: since.get(c.id).at,
    startedAt: c.begunAt || w?.startedAt || null,
    memBytes: w?.memBytes ?? null,
    terminalTitle: null,
    firstPrompt: s.firstPrompt || null,
    // The prompt's time is the last input's, and the reply's the last change.
    lastPrompt: s.lastPrompt ? { ...s.lastPrompt, at: c.inputAt } : null,
    lastReply: s.lastReply ? { ...s.lastReply, at: c.changedAt } : null,
    prompts: s.prompts || 0,
    outputTokens: 0,
    ticketRefs: s.ticketRefs || [],
    tools: st.status === 'idle' ? [] : s.tools || [],
    subagents: NO_SUBAGENTS,
  };
}

// The cards for these conversations and windows, as the page shows sessions.
function agentsFrom(convs, wins, { open = isOpen, now = Date.now() } = {}) {
  const { byPid, unmatched } = matchWindows(convs, wins, open);
  const agents = [...wins.filter((w) => byPid.has(w.pid)).map((w) => card(byPid.get(w.pid), w, now)), ...unmatched.map((c) => card(c, null, now))];
  const live = new Set(agents.map((a) => a.id));
  for (const id of since.keys()) if (!live.has(id)) since.delete(id);
  return agents;
}

// ---- to-dos ----------------------------------------------------------------------------

// To-dos started in Antigravity, which picks its conversation's ID itself:
// each is linked to the first conversation begun in its folder after it.
let expected = [];

function expect(cwd, then, now = Date.now()) {
  expected.push({ cwd: path.resolve(cwd), at: now, then });
}

function settleExpected(now) {
  if (!expected.length) return;
  const same = (a, b) => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
  expected = expected.filter((e) => {
    if (now - e.at > EXPECT_MS) return false;
    const c = conversations
      .filter((x) => x.cwd && same(path.resolve(x.cwd), e.cwd) && (x.begunAt || 0) >= e.at - START_SLACK_MS)
      .sort((a, b) => (a.begunAt || 0) - (b.begunAt || 0))[0];
    if (!c) return true;
    e.then(c.id);
    return false;
  });
}

// Antigravity's cards, and the windows whose tab titles the next snapshot
// needs. Its conversations are only read while one of its windows is open,
// or a to-do waits for one.
function snapshot(now = Date.now()) {
  refreshWindows();
  if (!windows.length && !expected.length) return { agents: [], windowPids: [] };
  refreshConversations(now);
  settleExpected(now);
  return { agents: windows.length ? agentsFrom(conversations, windows, { now }) : [], windowPids: windows.map((w) => w.pid) };
}

// ---- driving sessions --------------------------------------------------------------------

// The command a new tab runs: agy, approving everything if Settings says to
// skip permission prompts, resuming a conversation if given one.
function command({ skipPermissions = false, resume = null } = {}) {
  const parts = ['agy'];
  if (skipPermissions) parts.push('--dangerously-skip-permissions');
  if (resume && UUID.test(resume)) parts.push('--conversation', resume);
  return parts.join(' ');
}

let installedAt = 0;
let installedAs = null;

// Whether agy is installed: on the PATH, or where its installer puts it.
function installed() {
  if (Date.now() - installedAt < 30000) return Boolean(installedAs);
  const names = IS_WIN ? ['agy.exe'] : ['agy'];
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    IS_WIN && process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'bin'),
    !IS_WIN && path.join(os.homedir(), '.local', 'bin'),
  ].filter(Boolean);
  installedAs = null;
  for (const dir of dirs) for (const n of names) if (!installedAs && fs.existsSync(path.join(dir, n))) installedAs = path.join(dir, n);
  installedAt = Date.now();
  return Boolean(installedAs) && hasSqlite();
}

// ---- history -----------------------------------------------------------------------------

// Conversations changed since `floor`, with their prompts and replies, for the
// history: [{ id, mtime, entry }], where mtime is when it last changed.
// Conversations `skip(id, mtime)` says no to aren't read.
function historyConversations(floor, skip = () => false) {
  const read = readConversations();
  if (!read) return [];
  const found = [];
  for (const c of read) {
    if (!c.changedAt || c.changedAt < floor || !c.cwd || skip(c.id, c.changedAt)) continue;
    const s = steps(c.id, c.changedAt);
    if (!s) continue;
    found.push({ id: c.id, mtime: c.changedAt, conversation: { ...c, begunAt: begunAt(c.id) }, steps: s });
  }
  return found;
}

module.exports = {
  snapshot,
  agentsFrom,
  matchWindows,
  stateOf,
  readSteps,
  fields,
  isSessionWindow,
  resumeArg,
  command,
  installed,
  expect,
  historyConversations,
  STEP,
  STATE,
  HOME,
};
