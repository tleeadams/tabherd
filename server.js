#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { snapshot, findAgent, sessionFile } = require('./lib/agents');
const terminals = require('./lib/terminals');
const { openDashboard } = require('./lib/open-dashboard');
const { scanRepos, resolveRepo, SOURCE_DIR } = require('./lib/repos');
const settings = require('./lib/settings');
const history = require('./lib/history');
const todos = require('./lib/todos');
const groups = require('./lib/groups');
const codex = require('./lib/codex');

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
const claudeCommand = () => (settings.get().skipPermissions ? 'claude --dangerously-skip-permissions' : 'claude');
function sessionCommand(app, resume = null) {
  if (app === 'codex') return codex.command({ skipPermissions: settings.get().skipPermissions, resume });
  return resume ? `${claudeCommand()} --resume ${resume}` : claudeCommand();
}
// The app new sessions start in, from Settings: Claude unless Codex is chosen
// and installed.
const newSessionApp = () => (settings.get().newSessionApp === 'codex' && codex.installed() ? 'codex' : 'claude');
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
        // To-dos first: a to-do goes on its session's card, and from there
        // into the history when the session closes.
        todos.observe(snap.agents, snap.now);
        snap.todos = todos.pending(snap.now);
        snap.todoStartsIn = todoStartsIn();
        // Each card's group, worked out here so every browser agrees. A to-do
        // with no folder is in the group of the folder it will start in.
        snap.groups = groups.list();
        for (const a of snap.agents) Object.assign(a, groups.groupOf(a));
        for (const t of snap.todos) Object.assign(t, groups.groupOf({ id: t.id, cwd: t.cwd || snap.todoStartsIn }));
        // Whether this computer has a terminal the dashboard can drive, for
        // Go to window, Catch up, Start, Resume and the repo menu.
        snap.terminals = terminals.terminals().some((t) => t.available);
        // Whether Codex can be chosen for new sessions, and which app they start in.
        snap.codexInstalled = codex.installed();
        snap.newSessionApp = newSessionApp();
        history.observe(snap.agents, snap.now);
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
  // A Codex session's window is only known once its tab's title names it.
  if (name === 'focus' && !agent.pid) {
    return send(res, 409, { ok: false, error: `Couldn't tell which window ${agent.title || agent.name} is in.` });
  }
  if (name === 'catch-up' && agent.status === 'waiting') {
    const label = agent.terminalTitle || agent.title || agent.name;
    return send(res, 409, { ok: false, error: `${label} is waiting on a prompt or dialog. Use Go to window and answer it first.` });
  }
  // Codex takes Catch up's prompt through its service, so nothing is typed
  // into its window, which comes forward if it's known. Stop interrupts the
  // turn it's running, then ends the Codex in its window.
  if (agent.app === 'codex' && name === 'catch-up') {
    const queued = await codex.queuePrompt(agent.id, CATCH_UP_PROMPT);
    if (!queued.ok) return send(res, 500, queued);
    const shown = agent.pid ? await terminals.focus(agent.pid) : null;
    return send(res, 200, { ok: true, queued: true, raised: Boolean(shown?.raised), window: shown?.window || null });
  }
  if (agent.app === 'codex' && name === 'stop') {
    const stopped = await codex.interrupt(agent.id);
    if (!stopped.ok) return send(res, 500, stopped);
    if (!agent.pid) return send(res, 200, { ok: true, interrupted: stopped.interrupted, windowLeft: true });
    const result = await terminals.stop(agent.pid);
    return send(res, result.ok ? 200 : 500, { ...result, interrupted: stopped.interrupted });
  }
  if (name === 'focus' || name === 'catch-up') {
    const prompt = name === 'catch-up' ? CATCH_UP_PROMPT : null;
    const result = await terminals.focus(agent.pid, { send: prompt, statusFile: sessionFile(agent.pid) });
    return send(res, result.ok ? 200 : 500, result);
  }
  if (name === 'stop') {
    const result = await terminals.stop(agent.pid);
    return send(res, result.ok ? 200 : 500, result);
  }
  return send(res, 404, { ok: false, error: 'Unknown action.' });
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
    if ((todo.app || newSessionApp()) === 'codex') {
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
      const opened = await openTab(cwd, `${claudeCommand()} --session-id ${sessionId} --name ${name}`);
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
      return send(res, 200, { root, home: os.homedir(), tree, all, count, excluded: excludedFolders.length, app, command: sessionCommand(app) });
    }

    if (url.pathname === '/api/settings') {
      // With the terminals this computer has, for the Terminal setting.
      if (req.method === 'GET') return send(res, 200, { ok: true, settings: settings.get(), terminals: terminals.terminals() });
      if (req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      const result = settings.update(await readJson(req));
      return send(res, result.ok ? 200 : 400, result);
    }

    if (url.pathname === '/api/repos/open') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      const dir = resolveRepo((await readJson(req)).path);
      if (!dir) return send(res, 404, { ok: false, error: 'That repo is not in the list. Rescan and try again.' });
      const result = await openTab(dir, sessionCommand(newSessionApp()));
      return send(res, result.ok ? 200 : 500, result);
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
      // A fresh snapshot first, so running sessions aren't mistaken for closed ones.
      await currentSnapshot();
      await history.backfill();
      return send(res, 200, { ok: true, sessions: history.list().map((s) => ({ ...s, ...groups.groupOf(s) })), groups: groups.list() });
    }

    const resume = url.pathname.match(/^\/api\/history\/([0-9a-f-]{36})\/resume$/i);
    if (resume) {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      const past = history.find(resume[1]);
      if (!past) return send(res, 404, { ok: false, error: 'That session is not in the history.' });
      if (history.isLive(past.id)) return send(res, 409, { ok: false, error: 'That session is already running.' });
      if (!fs.existsSync(past.cwd)) return send(res, 400, { ok: false, error: `Its folder no longer exists: ${past.cwd}` });
      // The ID comes from the history's own records, which only hold UUIDs.
      const result = await openTab(past.cwd, sessionCommand(past.app || 'claude', past.id));
      return send(res, result.ok ? 200 : 500, result);
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

    const m = url.pathname.match(/^\/api\/agents\/([0-9a-f-]{36})\/(focus|catch-up|open-folder|stop)$/i);
    if (m) {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      if (req.headers['x-agents-token'] !== TOKEN) return send(res, 403, { error: 'Missing or bad token' });
      return await action(res, m[1], m[2]);
    }

    const file = req.method === 'GET' && STATIC[url.pathname];
    if (file) {
      let body = fs.readFileSync(path.join(PUBLIC_DIR, file[0]));
      if (file[0] === 'index.html') body = body.toString('utf8').replace('%%TOKEN%%', TOKEN);
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
        openDashboard(url);
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
    if (process.argv.includes('--open')) openDashboard(url);
    // Fills in sessions that closed while the server wasn't running. After the
    // first snapshot, so sessions that are still running aren't read.
    currentSnapshot()
      .then(() => history.backfill())
      .catch(() => {});
    if (process.argv.includes('--exit-when-idle')) {
      setInterval(() => !streams.size && Date.now() - lastRequestAt > IDLE_EXIT_MS && process.exit(0), 30000).unref();
    }
  });
}

main();
