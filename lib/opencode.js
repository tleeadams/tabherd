'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const terminals = require('./terminals');
const refs = require('./ticket-refs');

// OpenCode's sessions as cards. OpenCode 2 runs one background service that
// all its windows use. Its address and password are in
// <state>/opencode/service.json, where <state> is XDG_STATE_HOME or
// ~/.local/state, as OpenCode has it on every system. A session has a card
// while a window shows it, found by the tab's title ("OC | <session title>"),
// and while it's working or waiting on you without one.

const IS_WIN = process.platform === 'win32';
const REFRESH_MS = 2000;
const REQUEST_MS = 3000;
const WINDOWS_REFRESH_MS = 3000;
const SESSIONS_LISTED = 50;
const MESSAGES_READ = 30;
const NO_SUBAGENTS = { running: [], finished: [], finishedTotal: 0 };
// OpenCode's commands that aren't a window with a session in it.
const NOT_A_SESSION = new Set([
  'upgrade',
  'update',
  'uninstall',
  'acp',
  'api',
  'debug',
  'auth',
  'mcp',
  'plugin',
  'models',
  'stats',
  'run',
  'session',
  'service',
  'reload',
  'machine',
  'pair',
  'serve',
]);
// A session's ID, as OpenCode makes them: safe in a command line as it is.
const SESSION_ID = /^ses_[A-Za-z0-9]{10,60}$/;

const stateFile = () => path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'opencode', 'service.json');

// The background service, if it's said where it is. Only one on this
// computer is used, as the password goes with every request.
function readService() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (typeof s.url !== 'string' || typeof s.password !== 'string' || !s.password) return null;
    const u = new URL(s.url);
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null;
    return { url: s.url.replace(/\/+$/, ''), auth: `Basic ${Buffer.from(`opencode:${s.password}`).toString('base64')}` };
  } catch {
    return null;
  }
}

async function request(service, route, { method = 'GET', body } = {}) {
  const res = await fetch(service.url + route, {
    method,
    headers: { Authorization: service.auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_MS),
    redirect: 'error',
  });
  if (!res.ok) {
    const err = new Error(`OpenCode answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({}));
}

const list = (answer) => (Array.isArray(answer?.data) ? answer.data : Array.isArray(answer) ? answer : []);

// ---- windows ------------------------------------------------------------------

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? null : String(stdout)));
  });
}

// Whether a process is OpenCode in a terminal: `opencode`, or its minimal
// interface, running no other command. A folder to start in is fine.
function isSessionWindow(name, args) {
  if (!/^opencode(\.exe)?$/i.test(name)) return false;
  const first = args.find((a) => !a.startsWith('-'));
  return !first || !NOT_A_SESSION.has(first);
}

// The session a window was started on, from its command line.
function sessionArg(args) {
  const at = args.findIndex((a) => a === '--session' || a === '-s');
  const id = at >= 0 ? args[at + 1] : args.find((a) => a.startsWith('--session='))?.slice(10);
  return id && SESSION_ID.test(id) ? id : null;
}

// The `opencode` processes running in terminals: [{ pid, memBytes, session }].
async function findWindows() {
  const found = [];
  const add = (pid, name, memBytes, args) => {
    if (isSessionWindow(name, args)) found.push({ pid, memBytes, session: sessionArg(args) });
  };
  if (IS_WIN) {
    const script =
      `Get-CimInstance Win32_Process -Filter "Name like 'opencode%'" | ForEach-Object { ` +
      `'{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.Name, $_.WorkingSetSize, $_.CommandLine }`;
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (out === null) return null;
    for (const line of out.split(/\r?\n/)) {
      const [pid, name, ws, ...cmd] = line.trim().split('|');
      if (!pid) continue;
      add(Number(pid), name, Number(ws) || null, cmd.join('|').replace(/^\s*("[^"]*"|\S+)\s*/, '').split(/\s+/).filter(Boolean));
    }
  } else {
    const out = await run('ps', ['-A', '-o', 'pid=,rss=,args=']);
    if (out === null) return null;
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
      if (m) add(Number(m[1]), path.basename(m[3]), Number(m[2]) * 1024, m[4].split(/\s+/).filter(Boolean));
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

// The session title in a tab's: "OC | Fix the login" → "Fix the login".
const titleIn = (tab) =>
  String(tab || '')
    .replace(/^[^\p{L}\p{N}]*OC\s*\|\s*/u, '')
    .trim();

// Each session's window: the one started on it, else the one whose tab
// shows its title, if only one does and no other session has that title.
function matchWindows(sessions, wins, titleFor = terminals.titleFor) {
  const bySession = new Map();
  const free = new Map(wins.map((w) => [w.pid, w]));
  for (const w of wins) {
    if (w.session && sessions.some((s) => s.id === w.session)) {
      bySession.set(w.session, w);
      free.delete(w.pid);
    }
  }
  const named = new Map();
  for (const s of sessions) if (s.title && !bySession.has(s.id)) named.set(s.title, (named.get(s.title) || 0) + 1);
  for (const s of sessions) {
    if (bySession.has(s.id) || !s.title || named.get(s.title) > 1) continue;
    const matches = [...free.values()].filter((w) => {
      const shown = titleIn(titleFor(w.pid));
      return shown === s.title || (shown.endsWith('…') && s.title.startsWith(shown.slice(0, -1)));
    });
    if (matches.length !== 1) continue;
    bySession.set(s.id, matches[0]);
    free.delete(matches[0].pid);
  }
  return bySession;
}

// ---- what each session is doing ----------------------------------------------------

// The latest prompt and reply, from messages newest first.
function lastTurn(messages) {
  const user = messages.find((m) => m?.type === 'user' && typeof m.text === 'string' && m.text.trim());
  const reply = messages.find((m) => m?.type === 'assistant' && (m.content || []).some((c) => c?.type === 'text' && c.text?.trim()));
  const text = reply
    ? reply.content
        .filter((c) => c?.type === 'text')
        .map((c) => c.text)
        .join('\n')
        .trim()
    : '';
  // The tickets they claim, give up or (in prompts) link, oldest first.
  const ticketRefs = [];
  for (const m of [...messages].reverse()) {
    if (m?.type === 'user' && typeof m.text === 'string') ticketRefs.push(...refs.find(m.text, 'prompt'));
    else if (m?.type === 'assistant') for (const c of m.content || []) if (c?.type === 'text' && typeof c.text === 'string') ticketRefs.push(...refs.find(c.text, 'reply'));
  }
  return {
    lastPrompt: user ? { text: user.text.trim().slice(0, 4000), at: user.time?.created || null } : null,
    lastReply: reply ? { text: text.slice(0, 8000), at: reply.time?.completed || reply.time?.created || null } : null,
    prompts: messages.filter((m) => m?.type === 'user').length,
    ticketRefs,
  };
}

// Needs you while it asks permission or a question, working while a turn
// runs, idle otherwise. A turn that failed needs you too.
function statusOf(s, { running, asks = [], forms = [] }) {
  const ask = asks[0];
  if (ask) {
    const what = ask.resources?.length ? `${ask.action}: ${ask.resources.join(', ')}` : ask.action;
    return { status: 'waiting', waitingFor: String(ask.message || `Permission to ${what || 'go on'}`).slice(0, 300), since: `ask:${ask.id}` };
  }
  const form = forms[0];
  if (form) return { status: 'waiting', waitingFor: String(form.title || 'It has a question for you').slice(0, 300), since: `form:${form.id}` };
  if (running) return { status: 'busy', waitingFor: null, detail: running.type && running.type !== 'running' ? running.type : null, at: s.time?.busy };
  if (s.outcome === 'failed' || s.outcome === 'error') return { status: 'waiting', waitingFor: 'Its last turn failed', at: s.time?.idle };
  return { status: 'idle', waitingFor: null, at: s.time?.idle || s.time?.updated };
}

let state = null;
let refreshing = null;
let refreshedAt = 0;
// Each session's latest prompt and reply, by ID, with the update they're from.
const turns = new Map();
// When each question or permission request was first seen.
const firstSeen = new Map();

async function refresh() {
  const service = readService();
  if (!service) {
    state = null;
    return;
  }
  const [active, listed] = await Promise.all([request(service, '/api/session/active'), request(service, `/api/session?limit=${SESSIONS_LISTED}`)]);
  const running = active?.data && typeof active.data === 'object' ? active.data : {};
  const sessions = list(listed).filter((s) => s?.id && SESSION_ID.test(s.id) && !s.parentID);
  // A running session older than the list, or one a window was started on,
  // is fetched by itself.
  for (const id of new Set([...Object.keys(running), ...windows.map((w) => w.session).filter(Boolean)])) {
    if (SESSION_ID.test(id) && !sessions.some((s) => s.id === id)) {
      const one = await request(service, `/api/session/${id}`).catch(() => null);
      if (one?.data?.id) sessions.push(one.data);
    }
  }
  const byWindow = matchWindows(sessions, windows);
  const shown = sessions.filter((s) => byWindow.has(s.id) || running[s.id]);
  const asks = new Map();
  const forms = new Map();
  await Promise.all(
    shown.map(async (s) => {
      const [a, f] = await Promise.all([
        request(service, `/api/session/${s.id}/permission`).catch(() => null),
        request(service, `/api/session/${s.id}/form`).catch(() => null),
      ]);
      asks.set(s.id, list(a));
      forms.set(s.id, list(f));
      const updated = s.time?.updated || 0;
      if (turns.get(s.id)?.updated !== updated) {
        const messages = await request(service, `/api/session/${s.id}/message?limit=${MESSAGES_READ}`).catch(() => null);
        if (messages) turns.set(s.id, { updated, ...lastTurn(list(messages)) });
      }
    }),
  );
  for (const id of turns.keys()) if (!shown.some((s) => s.id === id)) turns.delete(id);
  state = { sessions: shown, running, asks, forms, byWindow, turns };
}

function poll() {
  if (refreshing || Date.now() - refreshedAt < REFRESH_MS) return;
  refreshing = refresh()
    .catch(() => {
      // Not running is the usual case, and shows nothing.
      state = null;
    })
    .finally(() => {
      refreshing = null;
      refreshedAt = Date.now();
    });
}

function seenSince(key, now) {
  if (!firstSeen.has(key)) firstSeen.set(key, now);
  return firstSeen.get(key);
}

// The cards for a state, as the page shows sessions.
function agentsFrom(s, { now = Date.now() } = {}) {
  if (!s) return [];
  const keys = new Set();
  const agents = s.sessions.map((session) => {
    const win = s.byWindow.get(session.id) || null;
    const st = statusOf(session, { running: s.running[session.id], asks: s.asks.get(session.id), forms: s.forms.get(session.id) });
    if (st.since) keys.add(st.since);
    const turn = s.turns?.get(session.id) || {};
    const dir = session.location?.directory || null;
    return {
      app: 'opencode',
      id: session.id,
      pid: win?.pid ?? null,
      title: session.title || null,
      name: session.title || (dir ? path.basename(dir) : '') || 'OpenCode',
      cwd: dir,
      kind: 'interactive',
      entrypoint: 'cli',
      status: st.status,
      waitingFor: st.waitingFor,
      detail: st.detail || null,
      statusSince: st.since ? seenSince(st.since, now) : st.at || session.time?.updated || null,
      startedAt: session.time?.created || null,
      model: session.model?.id || null,
      modelName: session.model?.id || null,
      outputTokens: session.tokens?.output || 0,
      lastPrompt: turn.lastPrompt || null,
      lastReply: turn.lastReply || null,
      prompts: turn.prompts || 0,
      ticketRefs: turn.ticketRefs || [],
      memBytes: win?.memBytes ?? null,
      terminalTitle: null,
      subagents: NO_SUBAGENTS,
    };
  });
  for (const key of firstSeen.keys()) if (!keys.has(key)) firstSeen.delete(key);
  return agents;
}

// OpenCode's cards from the last check, which checks again in the
// background, and the windows whose tab titles should be read.
function snapshot() {
  refreshWindows();
  poll();
  return { agents: agentsFrom(state), windowPids: windows.map((w) => w.pid) };
}

// ---- driving sessions ------------------------------------------------------------

// Stops the turn a session is running.
async function interrupt(id) {
  const service = readService();
  if (!service) return { ok: false, error: "OpenCode's background service isn't running." };
  try {
    await request(service, `/api/session/${encodeURIComponent(id)}/interrupt`, { method: 'POST', body: {} });
    refreshedAt = 0;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Couldn't stop OpenCode's turn: ${err.message}` };
  }
}

// Sends a prompt, which waits for the turn running, if any, to end.
async function queuePrompt(id, text) {
  const service = readService();
  if (!service) return { ok: false, error: "OpenCode's background service isn't running." };
  try {
    await request(service, `/api/session/${encodeURIComponent(id)}/prompt`, { method: 'POST', body: { text, delivery: 'queue' } });
    refreshedAt = 0;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Couldn't send OpenCode the prompt: ${err.message}` };
  }
}

// The command a new tab runs: OpenCode, approving what isn't denied if
// Settings says to skip permission prompts, on a session if given one.
function command({ skipPermissions = false, resume = null } = {}) {
  const auto = skipPermissions ? ' --auto' : '';
  return resume && SESSION_ID.test(resume) ? `opencode${auto} --session ${resume}` : `opencode${auto}`;
}

module.exports = { snapshot, interrupt, queuePrompt, command, agentsFrom, statusOf, lastTurn, matchWindows, isSessionWindow, sessionArg, titleIn, SESSION_ID };
