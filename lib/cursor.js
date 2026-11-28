'use strict';

// Cursor CLI's sessions (cursor-agent), as cards like Claude's. Each chat has
// a folder, <config>/chats/<hash of its folder>/<chat ID>/, where <config> is
// CURSOR_CONFIG_DIR, else $XDG_CONFIG_HOME/cursor, else ~/.cursor. Its
// meta.json gives the chat's folder, its title once it has one, and when it
// began and changed. Its transcript,
// <data>/projects/<folder as a name>/agent-transcripts/<ID>/<ID>.jsonl, where
// <data> is CURSOR_DATA_DIR or ~/.cursor, has what was asked and answered as
// the turn goes, and a line where each turn ended.
//
// Cursor records no process for a chat, so each window is matched to its
// chat by its tab's title, which Cursor sets to the chat's title, or by the
// chat begun in it since it started. With Cursor's status indicators on
// (/status-indicators), the title also says whether it's working, waiting for
// you or ready. Without them, the transcript says whether a turn is running,
// but not that it's waiting on an approval.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, exec } = require('child_process');
const { Transcript, clip } = require('./transcript');
const terminals = require('./terminals');

const IS_WIN = process.platform === 'win32';
const setting = (name) => (process.env[name] || '').trim();
const CONFIG_DIR = setting('CURSOR_CONFIG_DIR') || (setting('XDG_CONFIG_HOME') ? path.join(setting('XDG_CONFIG_HOME'), 'cursor') : path.join(os.homedir(), '.cursor'));
const CHATS_DIR = path.join(CONFIG_DIR, 'chats');
const PROJECTS_DIR = path.join(setting('CURSOR_DATA_DIR') || path.join(os.homedir(), '.cursor'), 'projects');
const WINDOWS_REFRESH_MS = 3000;
const CHATS_REFRESH_MS = 3000;
const SEARCH_AGAIN_MS = 10000;
// A chat begun this soon before its window's process was seen to start is
// still that window's: the two clocks are read separately.
const START_SLACK_MS = 2000;
const NO_SUBAGENTS = { running: [], finished: [], finishedTotal: 0 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// cursor-agent runs as the Node its install brought, on
// .../cursor-agent/versions/<version>/index.js, then its own arguments.
const ENTRY = /cursor-agent[\\/]versions[\\/]([^\\/"\s]+)[\\/]index\.js"?(.*)$/i;
// Its commands that aren't a window with a chat in it, and the flags that
// run without one.
const NOT_A_SESSION = new Set(
  'login logout mcp plugin worker worker-server status whoami models team bedrock about update upgrade create-chat generate-rule rule help'.split(' '),
);
const NO_WINDOW = new Set(['-p', '--print', '-v', '--version', '-h', '--help', '--list-models']);
// What Cursor calls a window or chat with no title yet, maybe with its
// worktree after it.
const UNTITLED = /^(Cursor Agent|New Agent)( \(.*\))?$/;
// The state at the end of a tab's title, with the status indicators on: the
// chat's title, " - ", an emoji, and the state ("⏳ Working ...", "✅ Ready").
const STATE_IN_TITLE =
  / - (?:\S+ )?(Moving to cloud|Loading conversation|Reconnecting|Running shell command|Planning|Working[ .·]*|Queued|Waiting for you|Waiting for confirmation|Reviewing changes|Ready)$/u;

// ---- windows ------------------------------------------------------------------

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? null : String(stdout)));
  });
}

// Whether cursor-agent's arguments are a window with a chat in it.
function isSessionWindow(args) {
  if (args.some((a) => NO_WINDOW.has(a))) return false;
  const first = args.find((a) => !a.startsWith('-'));
  return !first || !NOT_A_SESSION.has(first);
}

// The chat a window was started on, from its command line.
function resumeArg(args) {
  const at = args.indexOf('--resume');
  const id = at >= 0 ? args[at + 1] : args.find((a) => a.startsWith('--resume='))?.slice(9);
  return id && UUID.test(id) ? id : null;
}

// What a process's command line says, if it's cursor-agent in a window: its
// version, and the chat and model it was started on.
function windowFrom(commandLine) {
  const m = String(commandLine || '').match(ENTRY);
  if (!m) return null;
  const args = m[2].trim().split(/\s+/).filter(Boolean);
  if (!isSessionWindow(args)) return null;
  const model = args[args.indexOf('--model') + 1];
  return { version: m[1], resume: resumeArg(args), model: args.includes('--model') && model && !model.startsWith('-') ? model : null };
}

// How long ps says a process has run, [[dd-]hh:]mm:ss, in ms.
function elapsed(text) {
  const m = String(text).match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  return m ? (((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000 : null;
}

// The cursor-agent processes in windows: [{ pid, memBytes, startedAt, version, resume, model }].
async function findWindows() {
  const found = [];
  const add = (pid, memBytes, startedAt, commandLine) => {
    const w = windowFrom(commandLine);
    if (w) found.push({ pid, memBytes, startedAt, ...w });
  };
  if (IS_WIN) {
    const script =
      `Get-CimInstance Win32_Process -Filter "Name like 'node%' and CommandLine like '%cursor-agent%'" | ForEach-Object { ` +
      `'{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.WorkingSetSize, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), $_.CommandLine }`;
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (out === null) return null;
    for (const line of out.split(/\r?\n/)) {
      const [pid, ws, start, ...cmd] = line.trim().split('|');
      if (pid) add(Number(pid), Number(ws) || null, Number(start) || null, cmd.join('|'));
    }
  } else {
    const out = await run('ps', ['-A', '-o', 'pid=,rss=,etime=,args=']);
    if (out === null) return null;
    const now = Date.now();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      const ran = m && elapsed(m[3]);
      if (m) add(Number(m[1]), Number(m[2]) * 1024, ran === null ? null : now - ran, m[4]);
    }
  }
  return found;
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

// What a tab's title shows: the chat's title, '' while it has none, and the
// state Cursor's status indicators add, if they're on.
function readTitle(tab) {
  const t = String(tab || '').trim();
  const m = t.match(STATE_IN_TITLE);
  const name = (m ? t.slice(0, m.index) : t).trim();
  return { name: UNTITLED.test(name) ? '' : name, state: m ? m[1].replace(/[ .·]+$/, '') : null };
}

// Whether a tab's title shows that chat: its title, maybe with its worktree after it.
const shows = (name, chat) => Boolean(name && chat.title && (name === chat.title || name.startsWith(`${chat.title} (`)));

// Each window's chat: the one it was started on, else the one whose title its
// tab shows, if no other chat has that title, else the newest begun since the
// window started, as a new chat has no title until its first prompt.
function matchWindows(chats, wins, titleFor = terminals.titleFor) {
  const byPid = new Map();
  const taken = new Set();
  const take = (w, c) => {
    byPid.set(w.pid, c);
    taken.add(c.id);
  };
  for (const w of wins) {
    const c = w.resume && chats.find((x) => x.id === w.resume);
    if (c) take(w, c);
  }
  const titles = new Map();
  for (const c of chats) if (c.title) titles.set(c.title, (titles.get(c.title) || 0) + 1);
  const shown = new Map(wins.map((w) => [w.pid, readTitle(titleFor(w.pid)).name]));
  for (const w of wins) {
    if (byPid.has(w.pid)) continue;
    const matches = chats.filter((c) => !taken.has(c.id) && shows(shown.get(w.pid), c));
    if (matches.length === 1 && titles.get(matches[0].title) === 1) take(w, matches[0]);
  }
  // The latest window first, so each takes the chats begun since it started,
  // and an earlier one those before.
  const rank = (name, c) => (shows(name, c) ? 0 : c.title ? 2 : 1);
  for (const w of wins.filter((x) => !byPid.has(x.pid) && x.startedAt).sort((a, b) => b.startedAt - a.startedAt)) {
    const name = shown.get(w.pid);
    const since = chats
      .filter((c) => !taken.has(c.id) && c.createdAt >= w.startedAt - START_SLACK_MS)
      .sort((a, b) => rank(name, a) - rank(name, b) || b.createdAt - a.createdAt);
    if (since[0]) take(w, since[0]);
  }
  return byPid;
}

// ---- chats ------------------------------------------------------------------------

function chatFrom(id, file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!m || typeof m !== 'object' || m.isSubagent) return null;
    const title = typeof m.title === 'string' ? m.title.trim() : '';
    return {
      id,
      title: title && !UNTITLED.test(title) ? title : null,
      cwd: typeof m.cwd === 'string' && m.cwd ? m.cwd : null,
      createdAt: Number(m.createdAtMs) || null,
      updatedAt: Number(m.updatedAtMs) || null,
      hasConversation: m.hasConversation === true,
    };
  } catch {
    return null;
  }
}

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

// Every chat's meta.json, read again only once it's changed.
const metas = new Map();

function readChats() {
  const chats = [];
  const seen = new Set();
  for (const hash of listDir(CHATS_DIR)) {
    for (const id of listDir(path.join(CHATS_DIR, hash))) {
      if (!UUID.test(id)) continue;
      const file = path.join(CHATS_DIR, hash, id, 'meta.json');
      let mtime;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      seen.add(file);
      let m = metas.get(file);
      if (!m || m.mtime !== mtime) {
        m = { mtime, chat: chatFrom(id, file) };
        // One caught while it's being written is read again next time.
        if (m.chat) metas.set(file, m);
        else metas.delete(file);
      }
      if (m.chat) chats.push(m.chat);
    }
  }
  for (const file of metas.keys()) if (!seen.has(file)) metas.delete(file);
  return chats;
}

let chats = [];
let chatsAt = 0;

function refreshChats(now = Date.now()) {
  if (now - chatsAt < CHATS_REFRESH_MS) return;
  chatsAt = now;
  chats = readChats();
}

// A folder as Cursor names its project folder: "C:\work\app" -> "C-work-app".
const folderName = (dir) =>
  String(dir)
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

const transcriptPaths = new Map();
const searchedAt = new Map();

// A chat's transcript: in its folder's project folder, else in any project
// folder, as a chat started with --workspace has that one's. A new chat has
// none until its first prompt.
function findTranscript(chat, now = Date.now()) {
  const cached = transcriptPaths.get(chat.id);
  if (cached && fs.existsSync(cached)) return cached;
  const inProject = (dir) => [path.join(PROJECTS_DIR, dir, 'agent-transcripts', chat.id, `${chat.id}.jsonl`), path.join(PROJECTS_DIR, dir, 'agent-transcripts', `${chat.id}.jsonl`)];
  let found = chat.cwd ? inProject(folderName(chat.cwd)).find((f) => fs.existsSync(f)) : null;
  if (!found && now - (searchedAt.get(chat.id) || 0) >= SEARCH_AGAIN_MS) {
    searchedAt.set(chat.id, now);
    for (const dir of listDir(PROJECTS_DIR)) {
      found = inProject(dir).find((f) => fs.existsSync(f));
      if (found) break;
    }
  }
  if (found) transcriptPaths.set(chat.id, found);
  return found || null;
}

// The prompt in a user line: what's in <user_query>, without the
// <timestamp> Cursor adds, and when that says it was sent.
function promptIn(text) {
  const t = String(text || '');
  const query = t.match(/<user_query>([\s\S]*?)<\/user_query>/);
  const prompt = (query ? query[1] : t.replace(/<timestamp>[\s\S]*?<\/timestamp>/, '')).trim();
  if (!prompt || (!query && prompt.startsWith('<'))) return null;
  return { text: prompt, at: sentAt(t.match(/<timestamp>([\s\S]*?)<\/timestamp>/)?.[1]) };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "Wednesday, Nov 25, 2026, 7:47 PM (UTC-5)", to the minute, in ms.
function sentAt(text) {
  const m = String(text || '').match(/([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4}),? (\d{1,2}):(\d{2})\s*(AM|PM)?\s*\(UTC(?:([+-])(\d{1,2})(?::?(\d{2}))?)?\)/i);
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (month < 0) return null;
  let hour = Number(m[4]) % (m[6] ? 12 : 24);
  if (m[6]?.toUpperCase() === 'PM') hour += 12;
  const offset = (m[7] === '-' ? -1 : 1) * (Number(m[8] || 0) * 60 + Number(m[9] || 0));
  return Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) - offset * 60000;
}

// What a tool call is about: its command, else its file, search or address.
function describe(input) {
  const a = input && typeof input === 'object' ? input : {};
  const text = a.command || a.path || a.file_path || a.target_file || a.pattern || a.query || a.url || Object.values(a).find((v) => typeof v === 'string' && v.length < 200) || '';
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 159)}…` : t;
}

// A transcript, read a few new bytes at a time like a Claude one, into the
// same summary, plus whether a turn is running and how the last one ended.
// Its lines have no times, so a reply is given the time the file was written,
// read just before its new lines are.
class CursorLog extends Transcript {
  reset() {
    super.reset();
    Object.assign(this.s, { turnOpen: false, lastTurn: null });
  }

  update() {
    try {
      this.writtenAt = fs.statSync(this.file).mtimeMs;
    } catch {
      return false;
    }
    return super.update();
  }

  line(line) {
    if (!line) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const s = this.s;
    if (e.type === 'turn_ended') {
      s.turnOpen = false;
      s.lastTurn = typeof e.status === 'string' ? e.status : null;
      s.tools.clear();
      return;
    }
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    const text = content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .trim();
    if (e.role === 'user') {
      const prompt = promptIn(text);
      if (!prompt) return;
      s.tools.clear();
      s.turnOpen = true;
      s.lastTurn = null;
      s.lastPrompt = { text: clip(prompt.text), at: prompt.at ?? this.writtenAt };
      s.firstPrompt = s.firstPrompt || s.lastPrompt;
      s.prompts++;
      this.noteTickets(prompt.text, 'prompt');
    } else if (e.role === 'assistant') {
      // A step's tool calls are done once the next step is written.
      s.tools.clear();
      content.forEach((c, i) => {
        if (c?.type === 'tool_use') s.tools.set(i, { name: c.name || 'Tool', detail: describe(c.input), at: null });
      });
      if (text) {
        s.lastReply = { text: clip(text), at: this.writtenAt };
        this.noteTickets(text, 'reply');
      }
    }
  }

  summary() {
    const s = this.s;
    return { ...super.summary(), contextLimit: 0, contextTokens: 0, turnOpen: s.turnOpen, lastTurn: s.lastTurn };
  }
}

const logs = new Map();

function readLog(file, used) {
  let log = logs.get(file);
  if (!log) {
    log = new CursorLog(file);
    logs.set(file, log);
  }
  used.add(file);
  return log.update() ? log.summary() : null;
}

// What an approval is for, from the tool call the turn stopped on.
function approvalFor(s) {
  const tool = s?.tools?.[s.tools.length - 1];
  if (!tool) return 'Approval';
  if (/^(shell|bash|terminal)/i.test(tool.name) && tool.detail) return `Approval: run ${tool.detail}`;
  return `Approval: ${[tool.name, tool.detail].filter(Boolean).join(' ')}`;
}

// A chat's state: from its tab's title, if the status indicators are on,
// else from its transcript, where a turn with no end is still running. A
// turn that failed needs you too.
function stateOf(state, s) {
  if (state === 'Waiting for confirmation') return { status: 'waiting', waitingFor: approvalFor(s) };
  if (state === 'Waiting for you') return { status: 'waiting', waitingFor: 'Your answer' };
  if (state && state !== 'Ready') return { status: 'busy', waitingFor: null };
  if (!state && s?.turnOpen) return { status: 'busy', waitingFor: null };
  if (s?.lastTurn === 'error') return { status: 'waiting', waitingFor: 'Its last turn failed' };
  return { status: 'idle', waitingFor: null };
}

// When each chat's state began, as first seen.
const since = new Map();

// The cards for these chats and windows, as the page shows sessions.
function agentsFrom(allChats, wins, { titleFor = terminals.titleFor, now = Date.now() } = {}) {
  const byPid = matchWindows(allChats, wins, titleFor);
  const used = new Set();
  const agents = [];
  for (const w of wins) {
    const chat = byPid.get(w.pid);
    if (!chat) continue;
    const file = findTranscript(chat, now);
    const s = file ? readLog(file, used) : null;
    const st = stateOf(readTitle(titleFor(w.pid)).state, s);
    const key = `${st.status}:${st.waitingFor}`;
    if (since.get(chat.id)?.key !== key) since.set(chat.id, { key, at: now });
    agents.push({
      ...(s || {}),
      app: 'cursor',
      id: chat.id,
      pid: w.pid,
      title: chat.title,
      name: chat.title || path.basename(chat.cwd || '') || 'Cursor',
      cwd: chat.cwd,
      kind: 'interactive',
      entrypoint: 'cli',
      version: w.version || null,
      model: w.model || null,
      modelName: w.model || null,
      status: st.status,
      waitingFor: st.waitingFor,
      statusSince: since.get(chat.id).at,
      startedAt: chat.createdAt || w.startedAt || null,
      memBytes: w.memBytes ?? null,
      terminalTitle: null,
      tools: st.status === 'idle' ? [] : s?.tools || [],
      subagents: NO_SUBAGENTS,
    });
  }
  for (const f of logs.keys()) if (!used.has(f)) logs.delete(f);
  const live = new Set(agents.map((a) => a.id));
  for (const id of since.keys()) if (!live.has(id)) since.delete(id);
  return agents;
}

// Cursor's cards, and the windows whose tab titles the next snapshot needs.
// Its chats are only read while one of its windows is open.
function snapshot(now = Date.now()) {
  refreshWindows();
  if (!windows.length) return { agents: [], windowPids: [] };
  refreshChats(now);
  return { agents: agentsFrom(chats, windows, { now }), windowPids: windows.map((w) => w.pid) };
}

// ---- driving sessions ------------------------------------------------------------

// The command a new tab runs: cursor-agent, allowing commands it doesn't deny
// if Settings says to skip permission prompts, resuming a chat if given one.
// A chat is kept with its folder, so it's resumed from there.
function command({ skipPermissions = false, resume = null } = {}) {
  const parts = ['cursor-agent'];
  if (skipPermissions) parts.push('--force');
  if (resume && UUID.test(resume)) parts.push('--resume', resume);
  return parts.join(' ');
}

// Makes an empty chat in a folder, for a to-do to start on, so the to-do
// knows its chat from the start: `cursor-agent create-chat` prints its ID.
function createChat(cwd) {
  return new Promise((resolve) => {
    exec(`${bin()} create-chat`, { cwd, windowsHide: true, timeout: 30000 }, (err, stdout) => {
      const id = String(stdout || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
      if (id) resolve({ ok: true, id: id.toLowerCase() });
      else resolve({ ok: false, error: `Cursor didn't make a chat${err ? `: ${String(err.message).split('\n')[0]}` : '.'}` });
    });
  });
}

let installedAt = 0;
let installedAs = null;

// Whether cursor-agent is installed: on the PATH, or where its installer puts it.
function installed() {
  if (Date.now() - installedAt < 30000) return Boolean(installedAs);
  const names = IS_WIN ? ['cursor-agent.cmd', 'cursor-agent.exe'] : ['cursor-agent'];
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    IS_WIN && process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'cursor-agent'),
    !IS_WIN && path.join(os.homedir(), '.local', 'bin'),
  ].filter(Boolean);
  installedAs = null;
  for (const dir of dirs) for (const n of names) if (!installedAs && fs.existsSync(path.join(dir, n))) installedAs = path.join(dir, n);
  installedAt = Date.now();
  return Boolean(installedAs);
}
// How to run it from here, by its full path when it was found.
const bin = () => (installed() ? `"${installedAs}"` : 'cursor-agent');

// ---- history -----------------------------------------------------------------------

// Chats with a transcript changed since `floor`: [{ id, file, mtime, chat }].
async function sessionFiles(floor) {
  const found = [];
  for (const chat of readChats()) {
    if (!chat.hasConversation || !chat.cwd || (chat.updatedAt || 0) < floor) continue;
    const file = findTranscript(chat);
    if (!file) continue;
    try {
      const mtime = (await fs.promises.stat(file)).mtimeMs;
      if (mtime >= floor) found.push({ id: chat.id, file, mtime, chat });
    } catch {}
  }
  return found;
}

module.exports = {
  snapshot,
  agentsFrom,
  matchWindows,
  readTitle,
  windowFrom,
  isSessionWindow,
  elapsed,
  promptIn,
  sentAt,
  stateOf,
  command,
  createChat,
  installed,
  sessionFiles,
  folderName,
  CursorLog,
  CHATS_DIR,
  PROJECTS_DIR,
};
