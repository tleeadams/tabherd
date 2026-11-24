'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Transcript } = require('./transcript');
const { PROJECTS_DIR } = require('./agents');
const codex = require('./codex');
const { Rollout } = require('./codex-rollout');
const copilot = require('./copilot');

const MAX_SESSIONS = 300;
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// Closed sessions by ID, saved as history.json.
let sessions = load();
// The interactive sessions in the last snapshot, and when it was taken.
let live = new Map();
let liveAt = 0;
// Transcripts that aren't interactive sessions, so aren't read again this run.
const skipped = new Map();
let scanning = null;

const interactive = (a) => !a.kind || a.kind === 'interactive';
const ms = (t) => (typeof t === 'number' ? t : (t && Date.parse(t)) || null);

function load() {
  const saved = store.read('history', null);
  const list = Array.isArray(saved?.sessions) ? saved.sessions : [];
  return new Map(list.filter((s) => s && UUID.test(s.id) && typeof s.cwd === 'string').map((s) => [s.id, s]));
}

function save() {
  const list = [...sessions.values()].sort((a, b) => b.closedAt - a.closedAt).slice(0, MAX_SESSIONS);
  sessions = new Map(list.map((s) => [s.id, s]));
  try {
    store.write('history', { sessions: list });
  } catch {}
}

// `mtime` is the transcript's modified time when it was last read, so an
// unchanged transcript isn't read again. A session seen closing has none yet.
function fromAgent(a, closedAt) {
  return {
    app: a.app || 'claude',
    // Run headless, with `claude -p`, as background reviews and scripts do.
    background: Boolean(a.background),
    id: a.id,
    name: a.name || null,
    terminalTitle: a.terminalTitle || null,
    title: a.title || null,
    cwd: a.cwd,
    gitBranch: a.gitBranch || null,
    model: a.model || null,
    modelName: a.modelName || null,
    startedAt: ms(a.startedAt),
    closedAt,
    firstPrompt: a.firstPrompt || null,
    lastPrompt: a.lastPrompt || null,
    lastReply: a.lastReply || null,
    recap: a.recap || null,
    prompts: a.prompts || 0,
    outputTokens: a.outputTokens || 0,
    prs: a.prs || [],
    // The to-do it was started from, so the notes aren't lost when the to-do goes.
    todo: a.todo ? { title: a.todo.title, notes: a.todo.notes } : null,
    mtime: null,
  };
}

// Keeps what only the live session showed: its name, its terminal tab's title
// and its to-do.
function fromTranscript(id, t, mtime, known, app = 'claude') {
  const s = t.summary();
  const o = t.origin();
  return {
    ...fromAgent(
      {
        ...s,
        app,
        id,
        background: known?.background || o.entrypoint === 'sdk-cli',
        cwd: known?.cwd || o.cwd,
        name: known?.name,
        terminalTitle: known?.terminalTitle,
        todo: known?.todo,
      },
      Math.max(known?.closedAt || 0, mtime),
    ),
    startedAt: known?.startedAt || ms(o.startedAt),
    mtime,
  };
}

// Called with each snapshot. A session that was live last time and isn't now
// has closed. One that's live again has been resumed, so it leaves the history
// until it closes again. A session closed before it was asked anything isn't
// kept: Claude saves no conversation for it, so it couldn't be resumed.
function observe(agents, now) {
  const next = new Map(agents.filter(interactive).map((a) => [a.id, a]));
  let changed = false;
  for (const id of next.keys()) if (sessions.delete(id)) changed = true;
  for (const [id, a] of live) {
    if (next.has(id) || !a.cwd || !a.prompts) continue;
    sessions.set(id, fromAgent(a, liveAt));
    changed = true;
  }
  live = next;
  liveAt = now;
  if (changed) save();
}

// Once the history is full, transcripts older than all of it would only be
// trimmed off again.
function oldestKept() {
  if (sessions.size < MAX_SESSIONS) return 0;
  return Math.min(...[...sessions.values()].map((s) => s.closedAt));
}

// Adds sessions from the last 30 days that closed while the server wasn't
// watching, from the transcripts Claude Code keeps, and updates any resumed
// and closed again since. Reading a transcript can take tens of milliseconds,
// so the scan yields between them.
async function scanTranscripts() {
  const floor = Math.max(Date.now() - LOOKBACK_MS, oldestKept());
  let changed = false;
  let dirs;
  try {
    dirs = await fs.promises.readdir(PROJECTS_DIR);
  } catch {
    return;
  }
  for (const dir of dirs) {
    let names;
    try {
      names = await fs.promises.readdir(path.join(PROJECTS_DIR, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      const id = name.match(SESSION_FILE)?.[1];
      if (!id || live.has(id)) continue;
      const file = path.join(PROJECTS_DIR, dir, name);
      let mtime;
      try {
        mtime = (await fs.promises.stat(file)).mtimeMs;
      } catch {
        continue;
      }
      const known = sessions.get(id);
      if (mtime < floor || known?.mtime === mtime || skipped.get(id) === mtime) continue;
      const t = new Transcript(file);
      if (!t.update()) continue;
      const { cwd, entrypoint } = t.origin();
      // Sessions in a terminal, and `claude -p` runs, which can be resumed in
      // one; not Agent SDK runs, which belong to the program that ran them. A
      // session with no prompts has nothing to go back to.
      if (!cwd || !['cli', 'sdk-cli'].includes(entrypoint) || !t.summary().prompts) {
        skipped.set(id, mtime);
        continue;
      }
      sessions.set(id, fromTranscript(id, t, mtime, known));
      changed = true;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  if (await scanCodex(floor)) changed = true;
  if (await scanCopilot(floor)) changed = true;
  if (changed) save();
}

// The same for Codex, from its session files, named as Codex named them.
// Not until the dashboard has heard from Codex which sessions are open, so
// none of those is taken for closed.
async function scanCodex(floor) {
  if (!codex.settled()) return false;
  const names = codex.sessionNames();
  let changed = false;
  for (const { id, file, mtime } of await codex.sessionFiles(floor)) {
    const known = sessions.get(id);
    if (live.has(id) || known?.mtime === mtime || skipped.get(id) === mtime) continue;
    const r = new Rollout(file);
    if (!r.update()) continue;
    const o = r.origin();
    // Subagents' sessions and `codex exec` runs aren't ones to go back to.
    if (!o.cwd || o.parentThreadId || typeof o.source !== 'string' || ['exec', 'mcp'].includes(o.source) || !r.summary().prompts) {
      skipped.set(id, mtime);
      continue;
    }
    sessions.set(id, { ...fromTranscript(id, r, mtime, known, 'codex'), title: names.get(id) || known?.title || null });
    changed = true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return changed;
}

// The same for the Copilot CLI's sessions. VS Code's are resumed in VS Code.
async function scanCopilot(floor) {
  let changed = false;
  for (const { id, file, mtime, workspace } of await copilot.sessionFiles(floor)) {
    const known = sessions.get(id);
    if (live.has(id) || known?.mtime === mtime || skipped.get(id) === mtime) continue;
    const log = new copilot.CopilotLog(file);
    if (!log.update() || /vscode/i.test(workspace.client_name || '') || !(workspace.cwd || log.origin().cwd) || !log.summary().prompts) {
      skipped.set(id, mtime);
      continue;
    }
    const entry = fromTranscript(id, log, mtime, { ...known, cwd: known?.cwd || workspace.cwd }, 'copilot');
    sessions.set(id, { ...entry, title: workspace.name || workspace.summary || known?.title || null });
    changed = true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return changed;
}

function backfill() {
  if (!scanning) scanning = scanTranscripts().finally(() => (scanning = null));
  return scanning;
}

// Newest first, leaving out sessions that are live again, and any recorded
// with no prompts before sessions like that were left out.
const list = () => [...sessions.values()].filter((s) => !live.has(s.id) && s.prompts > 0).sort((a, b) => b.closedAt - a.closedAt);
const find = (id) => sessions.get(id) || null;
const isLive = (id) => live.has(id);

module.exports = { observe, backfill, list, find, isLive };
