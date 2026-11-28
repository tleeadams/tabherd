#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { snapshot, findAgent, sessionFile } = require('./lib/agents');
const claudeDirs = require('./lib/claude-dirs');
const terminals = require('./lib/terminals');
const { openDashboard } = require('./lib/open-dashboard');
const { scanRepos, resolveRepo, SOURCE_DIR } = require('./lib/repos');
const settings = require('./lib/settings');
const history = require('./lib/history');
const todos = require('./lib/todos');
const groups = require('./lib/groups');
const filters = require('./lib/filters');
const codex = require('./lib/codex');
const copilot = require('./lib/copilot');
const opencode = require('./lib/opencode');
const cursor = require('./lib/cursor');
const antigravity = require('./lib/antigravity');
const vscode = require('./lib/vscode');
const assistant = require('./lib/assistant');
const comfy = require('./lib/comfy');
const localai = require('./lib/localai');
const ollama = require('./lib/ollama');
const lmstudio = require('./lib/lmstudio');
const llamacpp = require('./lib/llamacpp');
const saved = require('./lib/saved');
const dismissed = require('./lib/dismissed');
const completed = require('./lib/completed');
const statusTimes = require('./lib/status-times');
const secrets = require('./lib/secrets');
const trackers = require('./lib/trackers');
const tickets = require('./lib/tickets');
const updates = require('./lib/updates');

const PORT = Number(process.env.PORT) || 4317;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
// Fixed here rather than sent by the page, so the API can't type arbitrary
// commands into agents.
const CATCH_UP_PROMPT = (
  process.env.CATCH_UP_PROMPT ||
  "Catch me up: where do things stand? Briefly cover what's done, what's in progress, and anything you need from me."
).replace(/\s+/g, ' ');
// What new tabs run: plain `claude` or `codex`, so it asks before acting,
// unless Settings says to skip permission prompts. With `resume`, they carry
// on that session.
// Claude, with the Claude Code folder it's to use when that isn't the
// default: a closed session's own, or for a new one, Settings' choice.
function claudeCommand(args = '', claudeDir = newSessionClaude()) {
  const cmd = `${settings.get().skipPermissions ? 'claude --dangerously-skip-permissions' : 'claude'}${args}`;
  const dir = claudeDirs.watched(claudeDir);
  return claudeDirs.isDefault(dir) ? cmd : terminals.withEnv('CLAUDE_CONFIG_DIR', dir, cmd);
}
// The Claude Code folder new Claude sessions start with: Settings' choice
// while it's watched, else the default.
const newSessionClaude = () => claudeDirs.watched(settings.get().newSessionClaude);
// How Claude (VS Code) starts for that account: its folder unless it's the
// default, its name, and the VS Code profile Settings gives it.
function vscodeAccount() {
  const dir = newSessionClaude();
  const profiles = settings.get().vscodeProfiles || {};
  const key = claudeDirs.isDefault(dir) ? '' : Object.keys(profiles).find((p) => p && claudeDirs.same(p, dir));
  return { claudeDir: claudeDirs.isDefault(dir) ? null : dir, account: claudeDirs.label(dir), profile: profiles[key ?? ''] || '' };
}
function sessionCommand(app, resume = null, claudeDir) {
  if (app === 'codex') return codex.command({ skipPermissions: settings.get().skipPermissions, resume });
  if (app === 'copilot') return copilot.command({ skipPermissions: settings.get().skipPermissions, resume });
  if (app === 'opencode') return opencode.command({ skipPermissions: settings.get().skipPermissions, resume });
  if (app === 'cursor') return cursor.command({ skipPermissions: settings.get().skipPermissions, resume });
  if (app === 'antigravity') return antigravity.command({ skipPermissions: settings.get().skipPermissions, resume });
  return claudeCommand(resume ? ` --resume ${resume}` : '', claudeDir);
}
// Whether each app that can start sessions, other than Claude, is installed.
const INSTALLED = { 'claude-vscode': vscode, codex, copilot, opencode, cursor, antigravity };
// The app new sessions start in, from Settings: Claude unless another is
// chosen and installed.
function newSessionApp() {
  const app = settings.get().newSessionApp;
  return INSTALLED[app]?.installed() ? app : 'claude';
}
// Where a to-do with no folder of its own starts: the Start in folder from
// Settings, else the repos folder. Claude can make a new project there.
const todoStartsIn = () => settings.get().todoStartFolder || SOURCE_DIR;
const SNAPSHOT_TTL_MS = 1000;
// With --exit-when-idle (as the desktop launcher starts it), the server stops
// once no dashboard has been open for this long.
const IDLE_EXIT_MS = 10 * 60 * 1000;
let lastRequestAt = Date.now();
// Required on every action, so other web pages cannot drive this server.
const TOKEN = crypto.randomBytes(24).toString('hex');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  // The Config Assistant's page.
  '/assistant': ['assistant.html', 'text/html; charset=utf-8'],
  '/assistant.js': ['assistant.js', 'text/javascript; charset=utf-8'],
  // Each language's words, other than English.
  '/lang/es.js': ['lang/es.js', 'text/javascript; charset=utf-8'],
  // The launchers check for a running server by asking for this one.
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/icons/tabherd-32.png': ['icons/tabherd-32.png', 'image/png'],
  '/icons/tabherd-64.png': ['icons/tabherd-64.png', 'image/png'],
};

let cached = null;
let cachedAt = 0;
let inflight = null;

function currentSnapshot() {
  if (cached && Date.now() - cachedAt < SNAPSHOT_TTL_MS) return Promise.resolve(cached);
  if (!inflight) {
    inflight = snapshot()
      .then((snap) => {
        // Failed jobs, chats and downloads that were cleared.
        snap.agents = snap.agents.filter((a) => !dismissed.has(a.id));
        // Time working, waiting, idle and queued, for each card's split. The
        // turns it's worked out from stay here.
        statusTimes.observe(snap.agents, snap.now);
        for (const a of snap.agents) {
          delete a.turns;
          delete a.turnStartedAt;
        }
        // To-dos first: a to-do goes on its session's card, and from there
        // into the history when the session closes.
        // To-dos started in VS Code take the first Claude session it starts
        // in their folder.
        vscode.settle(snap.agents, { now: snap.now, taken: todos.hasSession });
        todos.observe(snap.agents, snap.now);
        snap.todos = todos.pending(snap.now);
        snap.todoStartsIn = todoStartsIn();
        // Each card's group, worked out here so every browser agrees. A to-do
        // with no folder is in the group of the folder it will start in.
        snap.groups = groups.list();
        for (const a of snap.agents) Object.assign(a, groups.groupOf(a));
        for (const t of snap.todos) Object.assign(t, groups.groupOf({ id: t.id, cwd: t.cwd || snap.todoStartsIn }));
        // The filter tabs after All, the same in every browser.
        snap.filters = filters.list();
        // Whether this computer has a terminal the dashboard can drive, for
        // Go to window, Catch up, Start, Resume and the repo menu.
        snap.terminals = terminals.terminals().some((t) => t.available);
        // Whether Codex can be chosen for new sessions, and which app they start in.
        snap.codexInstalled = codex.installed();
        // Whether Codex's open sessions are known yet, so the first-run tour
        // waits for them.
        snap.settled = codex.settled();
        snap.copilotInstalled = copilot.installed();
        snap.opencodeInstalled = opencode.installed();
        snap.cursorInstalled = cursor.installed();
        snap.antigravityInstalled = antigravity.installed();
        snap.claudeVscodeInstalled = vscode.installed();
        snap.newSessionApp = newSessionApp();
        // The Claude Code folders watched, for the account filter and tags.
        snap.claudeAccounts = claudeDirs.list().map((dir) => ({ dir, label: claudeDirs.label(dir) }));
        // Each session's and to-do's tickets, before the history takes the
        // sessions that closed.
        tickets.observe(snap.agents, snap.now);
        for (const t of snap.todos) t.tickets = tickets.forTodo(t, snap.now);
        // Whether there are trackers, so cards offer + Ticket.
        snap.trackerCount = (settings.get().trackers || []).length;
        history.observe(snap.agents, snap.now);
        // Sessions marked complete, which a session asked more once resumed
        // no longer is.
        completed.observe(snap.agents);
        for (const a of snap.agents) {
          const at = completed.at(a.id);
          if (at) a.completedAt = at;
        }
        // Sessions Save and close or Complete is waiting on: each closes once
        // it's done.
        closeFinished(snap.agents);
        snap.closing = [...closing.keys()];
        const last = saved.get();
        snap.saved = last ? { savedAt: last.savedAt, count: last.sessions.length } : null;
        // This version, whether to check for a newer one, and any found.
        snap.updates = updateSummary();
        cached = snap;
        cachedAt = Date.now();
        return snap;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

// Open dashboards get each snapshot pushed to them. A browser slows timers in
// hidden or covered windows to as little as once a minute, but a pushed message
// is handled at once, so the page can ding the moment an agent needs you.
const STREAM_MS = 2000;
const streams = new Set();
let streamTimer = null;

function pushSnapshot() {
  currentSnapshot()
    .then((snap) => {
      const message = `data: ${JSON.stringify(snap)}\n\n`;
      for (const res of streams) res.write(message);
    })
    .catch(() => {});
}

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.write('retry: 2000\n\n');
  streams.add(res);
  pushSnapshot();
  if (!streamTimer) streamTimer = setInterval(pushSnapshot, STREAM_MS);
  req.on('close', () => {
    streams.delete(res);
    lastRequestAt = Date.now();
    if (!streams.size) {
      clearInterval(streamTimer);
      streamTimer = null;
    }
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data:",
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// The settings as the page sees them: a key only says whether one is set, and
// the trackers come from their own routes.
const forPage = (s) => ({
  ...s,
  localaiKey: '',
  localaiKeySet: Boolean(s.localaiKey),
  lmstudioKey: '',
  lmstudioKeySet: Boolean(s.lmstudioKey),
  trackers: undefined,
  // The default Claude Code folder, and the other ~/.claude-* folders to choose from.
  claudeDefault: claudeDirs.DEFAULT,
  claudeFound: claudeDirs.others(),
});

// Settings → Tickets: the trackers without their tokens, and how secrets are
// kept on this computer.
const trackersForPage = () => ({
  ok: true,
  trackers: trackers.forPage(settings.get().trackers),
  // Each tracker's last failed lookup, if it hasn't answered since.
  problems: tickets.problems(),
  secrets: { ...secrets.status(), unreadable: settings.unreadableKeys() },
});

async function trackerAction(res, name, body) {
  const list = settings.get().trackers;
  if (name === 'list') return send(res, 200, trackersForPage());
  if (name === 'test') {
    const t = list.find((x) => x.id === body.id);
    if (!t) return send(res, 404, { ok: false, error: 'That tracker is gone.' });
    return send(res, 200, await trackers.test(t));
  }
  const result = name === 'save' ? trackers.save(list, body.tracker) : { ok: true, list: trackers.remove(list, body.id) };
  if (!result.ok) return send(res, 400, result);
  const saved = settings.update({ trackers: result.list }, { internal: true });
  if (!saved.ok) return send(res, 500, saved);
  // What was read with its old sign-in, or from it, goes.
  tickets.forget(name === 'save' ? result.tracker.id : body.id);
  cached = null;
  return send(res, 200, { ...trackersForPage(), id: result.tracker?.id });
}

// Other apps' addresses and keys, from Settings.
function configureApps() {
  const s = settings.get();
  claudeDirs.configure(s.claudeFolders);
  comfy.configure({ url: s.comfyUrl });
  localai.configure({ url: s.localaiUrl, key: s.localaiKey });
  ollama.configure({ url: s.ollamaUrl });
  lmstudio.configure({ url: s.lmstudioUrl, key: s.lmstudioKey });
  llamacpp.configure({ url: s.llamacppUrl });
}
configureApps();

const updateSummary = () => updates.summary(settings.get().updateCheck, settings.get().updatePrereleases);

// Checks GitHub for a newer Tabherd, if Settings says to and it's been a day,
// or at once for Check now, and tells open dashboards what it found.
async function checkForUpdates({ force = false } = {}) {
  const result = await updates.check({ enabled: settings.get().updateCheck === true, force });
  cached = null;
  if (streams.size) pushSnapshot();
  return result;
}

// Opens a tab running `command` in `dir`, in the terminal chosen in Settings.
// The command is always built here, never sent by the page.
const openTab = (dir, command) => terminals.open(dir, command, { terminal: settings.get().terminal });

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      // Room for every group's folders, at their most.
      if (body.length > 262144) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

async function action(res, sessionId, name) {
  const agent = await findAgent(sessionId);
  if (!agent) return send(res, 404, { ok: false, error: 'That session is no longer running.' });
  cached = null;
  if (name === 'open-folder') {
    if (!agent.cwd || !fs.existsSync(agent.cwd)) return send(res, 400, { ok: false, error: 'Folder not found.' });
    terminals.openFolder(agent.cwd);
    return send(res, 200, { ok: true });
  }
  // A failed job, chat or download, cleared from the dashboard.
  if (name === 'dismiss') {
    if (!(agent.actions || []).includes('dismiss')) return send(res, 400, { ok: false, error: "That can't be cleared: it's still going." });
    dismissed.add(agent.id);
    pushSnapshot();
    return send(res, 200, { ok: true });
  }
  // A session marked complete, then closed as Save and close closes it: a
  // working one once its turn ends. One that can't be closed isn't marked.
  if (name === 'complete') {
    if (!closable(agent)) return send(res, 400, { ok: false, error: "That session can't be closed from here." });
    completed.add(agent.id, agent.prompts);
    if (working(agent)) {
      closing.set(agent.id, agent.name);
      pushSnapshot();
      return send(res, 200, { ok: true, waiting: true });
    }
    const result = await closeSession(agent).catch((err) => ({ ok: false, error: err.message }));
    if (!result.ok) completed.remove(agent.id);
    pushSnapshot();
    return send(res, result.ok ? 200 : 500, result);
  }
  // LocalAI: Unload a model, Stop a chat's turn, Cancel a download or agent
  // job. Ollama, LM Studio and llama.cpp: Unload a model.
  const service = { localai, ollama, lmstudio, llamacpp }[agent.app];
  if (service && ['stop', 'cancel', 'unload'].includes(name)) {
    const result = await service.act(agent, name);
    return send(res, result.ok ? 200 : 500, result);
  }
  // A ComfyUI job: Stop and Cancel go to its ComfyUI, which ends a running
  // job or takes a queued one out of the queue. A model's Unload frees all of
  // its ComfyUI's models.
  if (agent.app === 'comfy' && ['stop', 'cancel', 'unload'].includes(name)) {
    const result = name === 'unload' ? await comfy.unload(agent) : await comfy.cancel(agent);
    return send(res, result.ok ? 200 : 500, result);
  }
  // A VS Code Copilot session runs in VS Code's agent host, with every other
  // VS Code session: its window can be brought up, and that's all.
  if (agent.app === 'copilot' && agent.entrypoint === 'vscode' && name !== 'focus' && name !== 'open-folder') {
    return send(res, 400, { ok: false, error: 'Use VS Code for that: this session runs inside it.' });
  }
  // A Codex session's window is only known once its tab's title names it.
  if (name === 'focus' && !agent.pid) {
    return send(res, 409, { ok: false, error: `Couldn't tell which window ${agent.title || agent.name} is in.` });
  }
  if (name === 'catch-up' && agent.status === 'waiting') {
    const label = agent.terminalTitle || agent.title || agent.name;
    return send(res, 409, { ok: false, error: `${label} is waiting on a prompt or dialog. Use Go to window and answer it first.` });
  }
  // Codex and OpenCode take Catch up's prompt through their services, so
  // nothing is typed into the window, which comes forward if it's known. Stop
  // interrupts the turn it's running, then ends the app in its window.
  const sessions = { codex, opencode }[agent.app];
  if (sessions && name === 'catch-up') {
    const queued = await sessions.queuePrompt(agent.id, CATCH_UP_PROMPT);
    if (!queued.ok) return send(res, 500, queued);
    const shown = agent.pid ? await terminals.focus(agent.pid) : null;
    return send(res, 200, { ok: true, queued: true, raised: Boolean(shown?.raised), window: shown?.window || null });
  }
  if (sessions && name === 'stop') {
    const stopped = await sessions.interrupt(agent.id);
    if (!stopped.ok) return send(res, 500, stopped);
    if (!agent.pid) return send(res, 200, { ok: true, interrupted: stopped.interrupted, windowLeft: true });
    const result = await terminals.stop(agent.pid);
    return send(res, result.ok ? 200 : 500, { ...result, interrupted: stopped.interrupted });
  }
  if (name === 'focus' || name === 'catch-up') {
    const prompt = name === 'catch-up' ? CATCH_UP_PROMPT : null;
    // Claude's registry file is checked again just before typing; other apps
    // were checked above.
    const result = await terminals.focus(agent.pid, { send: prompt, statusFile: agent.app === 'claude' ? sessionFile(agent) : '' });
    return send(res, result.ok ? 200 : 500, result);
  }
  if (name === 'stop') {
    const result = await terminals.stop(agent.pid);
    return send(res, result.ok ? 200 : 500, result);
  }
  return send(res, 404, { ok: false, error: 'Unknown action.' });
}

// ---- Save and close, and Resume last session ----------------------------------

// The sessions Save and close takes: Claude's, Codex's, OpenCode's,
// Cursor's and Antigravity's in a terminal. Not background runs, which have no tab, nor
// sessions in a VS Code panel, which has no shell to close.
const closable = (a) =>
  (a.app === 'claude' && !a.background && (!a.kind || a.kind === 'interactive') && (!a.entrypoint || a.entrypoint === 'cli')) ||
  a.app === 'codex' ||
  a.app === 'opencode' ||
  a.app === 'cursor' ||
  a.app === 'antigravity' ||
  (a.app === 'copilot' && a.entrypoint === 'cli');
const working = (a) => a.status === 'busy' || a.status === 'shell';
// Waiting to close once they're done: session ID -> its name.
const closing = new Map();

// Ends a session and its tab. A Codex or OpenCode session's turn is
// interrupted first, and one whose window isn't known can't be closed from here.
async function closeSession(a) {
  if (a.app === 'codex' || a.app === 'opencode') {
    await { codex, opencode }[a.app].interrupt(a.id);
    if (!a.pid) return { ok: false, error: "its window isn't known" };
  }
  return terminals.close(a.pid);
}

function closeFinished(agents) {
  for (const [id] of closing) {
    const a = agents.find((x) => x.id === id);
    if (!a) closing.delete(id);
    else if (!working(a)) {
      closing.delete(id);
      closeSession(a).catch(() => {});
    }
  }
}

// Saves every open session, replacing the last saved set, then closes them.
// Working ones close now, or with `wait` once they finish their turn. A
// session that was never asked anything has nothing to resume, and one
// marked complete is done, so they're closed but not saved.
async function saveAndClose(res, body) {
  cached = null;
  const snap = await currentSnapshot();
  const open = snap.agents.filter(closable);
  const set = saved.save(
    open
      .filter((a) => a.prompts > 0 && !a.completedAt)
      .map((a) => ({ app: a.app, id: a.id, cwd: a.cwd, name: a.terminalTitle || a.title || a.name, claudeDir: a.claudeDir })),
    snap.now,
  );
  const failed = [];
  let closed = 0;
  for (const a of open) {
    if (body.wait && working(a)) {
      closing.set(a.id, a.name);
      continue;
    }
    const result = await closeSession(a).catch((err) => ({ ok: false, error: err.message }));
    if (result.ok) closed++;
    else failed.push({ name: a.terminalTitle || a.title || a.name, error: result.error });
  }
  cached = null;
  pushSnapshot();
  return send(res, 200, { ok: true, saved: set.sessions.length, closed, waiting: closing.size, failed });
}

// Opens each session in the saved set in a terminal tab, carrying on its
// conversation. Ones that are open already, or whose folder has gone, are
// skipped.
async function resumeLast(res) {
  const set = saved.get();
  if (!set?.sessions.length) return send(res, 404, { ok: false, error: 'There is no saved session to resume.' });
  cached = null;
  const snap = await currentSnapshot();
  const open = new Set(snap.agents.map((a) => a.id));
  const skipped = [];
  let opened = 0;
  for (const s of set.sessions) {
    if (open.has(s.id)) skipped.push({ name: s.name, why: 'already open' });
    else if (!fs.existsSync(s.cwd)) skipped.push({ name: s.name, why: 'its folder is gone' });
    else {
      // The ID comes from the saved set, which only holds session IDs, each
      // safe in a command line (session-id.js).
      const result = await openTab(s.cwd, sessionCommand(s.app, s.id, s.claudeDir));
      if (result.ok) opened++;
      else skipped.push({ name: s.name, why: result.error });
      // One at a time, so each tab opens before the next.
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
  return send(res, 200, { ok: true, opened, skipped });
}

// Everything about a to-do's folder and session is decided here: the folder
// comes from the repo scan or the folder picker, never from the page, and the
// session ID is made here.
async function todoAction(res, id, name, body) {
  const todo = todos.find(id);
  if (!todo) return send(res, 404, { ok: false, error: 'That to-do no longer exists.' });
  let result;
  if (name === 'edit') result = todos.edit(id, body);
  else if (name === 'delete') result = todos.remove(id);
  else if (name === 'folder') {
    let dir;
    if (body.pick) {
      const start = todo.cwd || todoStartsIn();
      const picked = await terminals.pickFolder(start, `Choose a folder for “${todo.title}”`);
      if (!picked.ok || picked.cancelled) return send(res, picked.ok ? 200 : 500, picked);
      dir = typeof picked.path === 'string' ? picked.path : '';
      // Virtual folders, such as This PC, have no path.
      if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
        return send(res, 400, { ok: false, error: "That isn't a folder Claude can start in. Choose one on a drive." });
      }
    } else {
      dir = resolveRepo(body.repo);
      if (!dir) return send(res, 404, { ok: false, error: 'That repo is not in the list. Rescan and try again.' });
    }
    result = todos.setFolder(id, dir);
    if (result.ok) result.cwd = dir;
  } else if (name === 'start') {
    if (todos.isLive(id)) return send(res, 409, { ok: false, error: 'Its session is already running.' });
    const cwd = todo.cwd || todoStartsIn();
    if (!fs.existsSync(cwd)) {
      const which = todo.cwd ? 'Its folder' : 'The folder to-dos start in';
      return send(res, 400, { ok: false, error: `${which} doesn't exist: ${cwd}` });
    }
    const app = todo.app || newSessionApp();
    if (app === 'claude-vscode') {
      // VS Code opens the folder and a Claude tab with the to-do filled in,
      // for you to send. The extension picks the session's ID, so the to-do
      // is linked to the first session it starts there.
      const opened = await vscode.startClaude(cwd, [todo.title, todo.notes].filter(Boolean).join('\n\n'), vscodeAccount());
      if (!opened.ok) return send(res, opened.error.startsWith('VS Code with') ? 400 : 500, opened);
      vscode.expect(cwd, (sessionId) => {
        todos.linked(id, sessionId);
        groups.carry(id, sessionId);
      });
      result = { ...todos.started(id, null), note: opened.note };
    } else if (app === 'copilot') {
      if (!copilot.installed()) return send(res, 400, { ok: false, error: "The Copilot CLI isn't installed on this computer." });
      // Like Claude: the server makes the session's ID, so it knows which
      // session the to-do became, and Copilot names the session after it.
      const sessionId = crypto.randomUUID();
      const name = terminals.quote(todo.title.replace(/"/g, '”'));
      const opened = await openTab(cwd, copilot.command({ skipPermissions: settings.get().skipPermissions, sessionId, name }));
      if (!opened.ok) return send(res, 500, opened);
      groups.carry(id, sessionId);
      result = todos.started(id, sessionId);
    } else if (app === 'opencode' || app === 'cursor') {
      // Their sessions are made first, named after the to-do where the app
      // allows it, so the to-do knows which one it became.
      if (!INSTALLED[app].installed()) {
        return send(res, 400, { ok: false, error: app === 'opencode' ? "OpenCode isn't installed on this computer." : "Cursor CLI isn't installed on this computer." });
      }
      const made = app === 'opencode' ? await opencode.createSession({ cwd, title: todo.title }) : await cursor.createChat(cwd);
      if (!made.ok) return send(res, 500, made);
      const opened = await openTab(cwd, sessionCommand(app, made.id));
      if (!opened.ok) return send(res, 500, opened);
      groups.carry(id, made.id);
      result = todos.started(id, made.id);
    } else if (app === 'antigravity') {
      if (!antigravity.installed()) return send(res, 400, { ok: false, error: "Antigravity isn't installed on this computer." });
      const opened = await openTab(cwd, sessionCommand('antigravity'));
      if (!opened.ok) return send(res, 500, opened);
      // Antigravity picks its conversation's ID itself, when it's first asked
      // something, so the to-do is linked to it then.
      antigravity.expect(cwd, (conversationId) => {
        todos.linked(id, conversationId);
        groups.carry(id, conversationId);
      });
      result = todos.started(id, null);
    } else if (app === 'codex') {
      if (!codex.installed()) return send(res, 400, { ok: false, error: "Codex isn't installed on this computer." });
      const opened = await openTab(cwd, sessionCommand('codex'));
      if (!opened.ok) return send(res, 500, opened);
      // Codex picks its session's ID itself, so the to-do is linked to the
      // session once it starts, and the session is named after the to-do then.
      codex.expect(cwd, (threadId) => {
        todos.linked(id, threadId);
        groups.carry(id, threadId);
        codex.rename(threadId, todo.title);
      });
      result = todos.started(id, null);
    } else {
      const sessionId = crypto.randomUUID();
      // Named after the to-do, which Claude shows in its tab's title and its
      // session list. Straight double quotes become curly ones: Windows
      // PowerShell 5.1 mangles them in a program's arguments.
      const name = terminals.quote(todo.title.replace(/"/g, '”'));
      const opened = await openTab(cwd, claudeCommand(` --session-id ${sessionId} --name ${name}`));
      if (!opened.ok) return send(res, 500, opened);
      groups.carry(id, sessionId);
      result = todos.started(id, sessionId);
    }
  }
  if (result.ok) {
    cached = null;
    pushSnapshot();
  }
  return send(res, result.ok ? 200 : 400, result);
}

const server = http.createServer(async (req, res) => {
  try {
    // Rejecting other Host headers blocks DNS-rebinding pages from reading prompts.
    if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, { error: 'Forbidden host' });
    lastRequestAt = Date.now();
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/api/agents') {
      return send(res, 200, await currentSnapshot());
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') return openStream(req, res);

    if (req.method === 'GET' && url.pathname === '/api/repos') {
      const { root, tree, all, count, excludedFolders } = scanRepos(url.searchParams.has('refresh'));
      const app = newSessionApp();
      const command = app === 'claude-vscode' ? null : sessionCommand(app);
      return send(res, 200, { root, home: os.homedir(), tree, all, count, excluded: excludedFolders.length, app, command });
    }

    if (url.pathname === '/api/settings') {
      // With the terminals this computer has, for the Terminal setting.
      if (req.method === 'GET') return send(res, 200, { ok: true, settings: forPage(settings.get()), terminals: terminals.terminals() });
      if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      const body = await readJson(req);
      const result = settings.update(body);
      if (result.ok) configureApps();
      // Every dashboard hears the answer to checking for updates, and a yes
      // checks now. Prereleases on or off needs no new check.
      if (result.ok && ('updateCheck' in body || 'updatePrereleases' in body)) {
        cached = null;
        pushSnapshot();
        if (body.updateCheck) checkForUpdates().catch(() => {});
      }
      return send(res, result.ok ? 200 : 400, result.ok ? { ...result, settings: forPage(result.settings) } : result);
    }

    // Settings → Tickets: list, save, remove or test a tracker. Even listing
    // needs the token, as it has the trackers' addresses and emails.
    const trackerRoute = url.pathname.match(/^\/api\/tickets\/trackers\/(list|save|remove|test)$/);
    if (trackerRoute) {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      return await trackerAction(res, trackerRoute[1], await readJson(req));
    }

    // A newer Tabherd's notes, and how to update this copy, for the update dialog.
    if (req.method === 'GET' && url.pathname === '/api/updates') {
      return send(res, 200, { ok: true, ...updates.details(settings.get().updatePrereleases) });
    }

    // Check now: asks GitHub at once, whatever Settings says, as someone asked.
    // The Config Assistant: what it can set up here, and its Apply and Undo.
    if (req.method === 'GET' && url.pathname === '/api/assistant') return send(res, 200, { tasks: assistant.list() });
    if (url.pathname === '/api/assistant/run') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      const body = await readJson(req);
      if (!['apply', 'undo'].includes(body.action)) return send(res, 400, { ok: false, error: 'Say apply or undo.' });
      const result = await assistant.run(String(body.task || ''), String(body.key || ''), body.action);
      return send(res, result.ok ? 200 : 500, { ...result, tasks: assistant.list() });
    }

    if (url.pathname === '/api/updates/check') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      const result = await checkForUpdates({ force: true });
      if (result.failedAt > result.checkedAt) return send(res, 502, { ok: false, error: `Couldn't reach GitHub: ${result.error}` });
      return send(res, 200, { ok: true, ...updateSummary() });
    }

    if (url.pathname === '/api/repos/open') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      const dir = resolveRepo((await readJson(req)).path);
      if (!dir) return send(res, 404, { ok: false, error: 'That repo is not in the list. Rescan and try again.' });
      const app = newSessionApp();
      const result = app === 'claude-vscode' ? await vscode.startClaude(dir, '', vscodeAccount()) : await openTab(dir, sessionCommand(app));
      return send(res, result.ok ? 200 : 500, result);
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      // A fresh snapshot first, so running sessions aren't mistaken for closed ones.
      await currentSnapshot();
      await history.backfill();
      return send(res, 200, {
        ok: true,
        sessions: history.list().map((s) => ({ ...s, ...groups.groupOf(s), completedAt: completed.at(s.id) })),
        groups: groups.list(),
      });
    }

    const resume = url.pathname.match(/^\/api\/history\/([0-9a-f-]{36}|ses_[A-Za-z0-9]{10,60})\/resume$/i);
    if (resume) {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      const past = history.find(resume[1]);
      if (!past) return send(res, 404, { ok: false, error: 'That session is not in the history.' });
      if (history.isLive(past.id)) return send(res, 409, { ok: false, error: 'That session is already running.' });
      if (!fs.existsSync(past.cwd)) return send(res, 400, { ok: false, error: `Its folder no longer exists: ${past.cwd}` });
      // The ID comes from the history's own records, which only hold session IDs.
      const result = await openTab(past.cwd, sessionCommand(past.app || 'claude', past.id, past.claudeDir));
      return send(res, result.ok ? 200 : 500, result);
    }

    // Save and close every open session, stop waiting on one, or resume the
    // last saved set.
    const sessionsAction = url.pathname.match(/^\/api\/sessions\/(save-close|keep-open|resume-last)$/);
    if (sessionsAction) {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      const body = await readJson(req);
      if (sessionsAction[1] === 'save-close') return await saveAndClose(res, body);
      if (sessionsAction[1] === 'resume-last') return await resumeLast(res);
      // Kept open, it's not complete either.
      closing.delete(String(body.id));
      completed.remove(String(body.id));
      cached = null;
      pushSnapshot();
      return send(res, 200, { ok: true });
    }

    // Every group at once, from the Settings editor; or one session or to-do
    // put in a group by hand.
    if (url.pathname === '/api/groups' || url.pathname === '/api/groups/place') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      const body = await readJson(req);
      const result = url.pathname === '/api/groups' ? groups.setGroups(body.groups) : groups.place(body.id, body.group === undefined ? 'auto' : body.group);
      if (result.ok) {
        cached = null;
        pushSnapshot();
      }
      return send(res, result.ok ? 200 : 400, result);
    }

    // Every filter at once, in order, as the page edits them; or the usual
    // ones back.
    if (url.pathname === '/api/filters') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      const body = await readJson(req);
      const result = filters.setFilters(body.reset === true ? filters.DEFAULTS : body.filters);
      if (result.ok) {
        cached = null;
        pushSnapshot();
      }
      return send(res, result.ok ? 200 : 400, result);
    }

    // A ticket's link or key pasted as a new to-do's title: its title and
    // description, to fill in the to-do.
    if (url.pathname === '/api/tickets/describe') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      const answer = await tickets.describe((await readJson(req))?.text);
      return send(res, answer.ok ? 200 : 400, answer);
    }

    // A card's + Ticket, a ticket's ✕, and the Complete dialog's options and
    // what it posts to the tickets. The session must be on the dashboard now,
    // and only the tickets on its card are written to.
    const ticketRoute = url.pathname.match(/^\/api\/tickets\/(add|remove|done-options|write)$/);
    if (ticketRoute) {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      const body = await readJson(req);
      const agent = (await currentSnapshot()).agents.find((a) => a.id === body?.id);
      if (!agent) return send(res, 404, { ok: false, error: 'That session is no longer running.' });
      const run = {
        add: () => tickets.add(agent, body.text),
        remove: () => tickets.remove(agent.id, body.chip),
        'done-options': () => tickets.doneOptions(agent),
        write: () => tickets.writeBack(agent, body.writes),
      }[ticketRoute[1]];
      const answer = await run();
      cached = null;
      pushSnapshot();
      return send(res, answer.ok ? 200 : 400, answer);
    }

    if (url.pathname === '/api/todos') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      const result = todos.create(await readJson(req));
      if (result.ok) {
        cached = null;
        pushSnapshot();
      }
      return send(res, result.ok ? 200 : 400, result);
    }

    const t = url.pathname.match(/^\/api\/todos\/([0-9a-f-]{36})(?:\/(delete|folder|start))?$/i);
    if (t) {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      return await todoAction(res, t[1], t[2] || 'edit', await readJson(req));
    }

    // Sessions have UUIDs, or OpenCode's ses_ IDs; jobs and models have IDs
    // such as comfy:<install>:<job>.
    // Either way it must be on the dashboard now.
    const m = url.pathname.match(/^\/api\/agents\/([^/]{1,300})\/(focus|catch-up|open-folder|stop|complete|cancel|unload|dismiss)$/i);
    if (m) {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      let id;
      try {
        id = decodeURIComponent(m[1]);
      } catch {
        return send(res, 400, { error: 'Bad ID' });
      }
      return await action(res, id, m[2]);
    }

    // A ComfyUI job's output, for its card. Only outputs on cards are served.
    if (req.method === 'GET' && url.pathname === '/api/comfy/view') {
      const p = Object.fromEntries(url.searchParams);
      const image = typeof p.i === 'string' && typeof p.filename === 'string' ? await comfy.view(p).catch(() => null) : null;
      if (!image) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff' });
      return res.end(image.body);
    }

    const file = req.method === 'GET' && STATIC[url.pathname];
    if (file) {
      let body = fs.readFileSync(path.join(PUBLIC_DIR, file[0]));
      if (file[0].endsWith('.html')) body = body.toString('utf8').replace('%%TOKEN%%', TOKEN);
      return send(res, 200, body, file[1]);
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

// Whether a Tabherd server answers at that address.
async function isDashboard(url) {
  try {
    const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(2000) });
    return res.ok && (await res.text()).includes('<title>Tabherd</title>');
  } catch {
    return false;
  }
}

// `tabherd setup` opens the Config Assistant rather than the dashboard.
const SETUP = process.argv.includes('setup');

async function main() {
  if (process.argv.includes('--once')) {
    const snap = await snapshot();
    for (const a of snap.agents) {
      const doing = a.tools?.length ? `${a.tools[0].name}: ${a.tools[0].detail}` : a.waitingFor || '';
      console.log(`${String(a.pid ?? '-').padEnd(7)} ${a.app.padEnd(7)} ${a.status.padEnd(8)} ${a.name.padEnd(28)} ${doing}`);
    }
    console.log(`${snap.agents.length} running session(s)`);
    return;
  }
  const url = `http://localhost:${PORT}`;
  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      // With --open, a dashboard server that's already running is opened
      // instead, so the `tabherd` command works either way.
      if (process.argv.includes('--open') && (await isDashboard(url))) {
        openDashboard(SETUP ? `${url}/assistant` : url);
        console.log(`Tabherd is already running: ${url}`);
        process.exit(0);
      }
      console.error(`Port ${PORT} is in use. Is the dashboard already open? Set PORT to use another one.`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, HOST, () => {
    console.log(`Tabherd dashboard: ${url}  (Ctrl+C to stop)`);
    if (process.argv.includes('--open')) openDashboard(SETUP ? `${url}/assistant` : url);
    // Fills in sessions that closed while the server wasn't running. After the
    // first snapshot, so sessions that are still running aren't read.
    currentSnapshot()
      .then(() => history.backfill())
      .catch(() => {});
    // Only once Settings says yes, and then once a day.
    checkForUpdates().catch(() => {});
    setInterval(() => checkForUpdates().catch(() => {}), 60 * 60 * 1000).unref();
    if (process.argv.includes('--exit-when-idle')) {
      setInterval(() => !streams.size && Date.now() - lastRequestAt > IDLE_EXIT_MS && process.exit(0), 30000).unref();
    }
  });
}

main();
