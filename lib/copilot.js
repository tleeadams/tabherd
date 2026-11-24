'use strict';

// GitHub Copilot sessions, as cards like Claude's: the Copilot CLI's, and the
// agent sessions VS Code runs on the same Copilot runtime, which keep their
// state in the same place. Each session has a folder,
// $COPILOT_HOME/session-state/<id>/ (~/.copilot unless set), holding
// workspace.yaml (its folder, name and which client runs it), events.jsonl
// (everything it did) and, while a process has it open, inuse.<pid>.lock.
// Copilot also keeps open-sessions-state.json: each open session, and
// whether it's working.
//
// Approval requests are in events.jsonl, answered or not; a question for
// you is only seen as the ask_user tool it comes from.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Transcript, clip } = require('./transcript');

const COPILOT_HOME = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
const STATE_DIR = path.join(COPILOT_HOME, 'session-state');
const OPEN_FILE = path.join(COPILOT_HOME, 'open-sessions-state.json');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Session folders changed this recently are checked for a process too: VS
// Code's sessions may not be in the open list.
const RECENT_MS = 6 * 60 * 60 * 1000;
const RESCAN_MS = 10000;
const NO_SUBAGENTS = { running: [], finished: [], finishedTotal: 0 };

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// workspace.yaml is flat key: value lines.
function readWorkspace(dir) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1).replace(/\\(["\\])/g, '$1');
    out[m[1]] = v === 'null' || v === '~' ? null : v;
  }
  return out;
}

// The process that has a session open, from its inuse.<pid>.lock, if it's
// still running. A lock left by a crash points at a process that's gone.
function owner(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    const m = n.match(/^inuse\.(\d+)\.lock$/);
    if (m && isRunning(Number(m[1]))) return Number(m[1]);
  }
  return null;
}

// ---- events.jsonl ----------------------------------------------------------------

// Read a few new bytes at a time, like a Claude transcript, into the same
// summary, plus the approvals still waiting and whether a turn is open.
class CopilotLog extends Transcript {
  reset() {
    super.reset();
    Object.assign(this.s, { version: null, turnOpen: false, approvals: new Map(), asking: new Map() });
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
    const d = e.data || {};
    if (e.timestamp) {
      s.lastEventAt = e.timestamp;
      s.startedAt = s.startedAt || e.timestamp;
    }
    switch (e.type) {
      case 'session.start':
        s.model = d.selectedModel || s.model;
        s.version = d.copilotVersion || d.version || null;
        s.cwd = s.cwd || d.context?.cwd || null;
        if (d.context?.branch) s.gitBranch = d.context.branch;
        break;
      case 'session.context_changed':
        if (d.context?.branch || d.branch) s.gitBranch = d.context?.branch || d.branch;
        break;
      case 'session.model_change':
        s.model = d.newModel || s.model;
        break;
      case 'user.message':
        // Messages Copilot adds itself, such as skill or system text, aren't prompts.
        if (d.source && /^(system|skill|hook|subagent|compaction|summar)/i.test(d.source)) break;
        if (typeof d.content === 'string' && d.content.trim()) {
          s.tools.clear();
          s.lastPrompt = { text: clip(d.content), at: e.timestamp };
          s.firstPrompt = s.firstPrompt || s.lastPrompt;
          s.prompts++;
        }
        break;
      case 'assistant.turn_start':
        s.turnOpen = true;
        break;
      case 'assistant.turn_end':
        s.turnOpen = false;
        break;
      case 'assistant.message':
        if (typeof d.content === 'string' && d.content.trim()) s.lastReply = { text: clip(d.content), at: e.timestamp };
        if (d.model) s.model = d.model;
        break;
      // Each model call: the model that answered, which in auto mode is the
      // one Copilot chose, and its tokens.
      case 'session.usage_record': {
        const u = d.usage || {};
        if (u.model) s.model = u.model;
        if (u.modelDisplayName) s.modelName = u.modelDisplayName;
        if (Number.isFinite(u.outputTokens)) s.outputTokens += u.outputTokens;
        break;
      }
      case 'session.auto_mode_resolved':
        if (d.chosenModel) s.model = d.chosenModel;
        break;
      case 'tool.execution_start':
        if (!d.toolCallId) break;
        s.tools.set(d.toolCallId, { name: d.toolTitle || d.toolName || 'Tool', detail: describe(d), at: e.timestamp });
        if (d.toolName === 'ask_user') s.asking.set(d.toolCallId, d.arguments?.question || '');
        break;
      case 'tool.execution_complete':
        s.tools.delete(d.toolCallId);
        s.asking.delete(d.toolCallId);
        break;
      case 'permission.requested':
        if (d.requestId) s.approvals.set(d.requestId, approvalText(d));
        break;
      case 'permission.completed':
        s.approvals.delete(d.requestId);
        break;
      case 'abort':
        s.turnOpen = false;
        s.tools.clear();
        s.approvals.clear();
        s.asking.clear();
        break;
      case 'session.compaction_complete':
      case 'session.compacted':
        s.compactions++;
        break;
    }
  }

  summary() {
    const s = this.s;
    return {
      ...super.summary(),
      contextLimit: 0,
      contextTokens: 0,
      turnOpen: s.turnOpen,
      approvals: [...s.approvals.values()],
      asking: [...s.asking.values()],
    };
  }
}

function describe(d) {
  const a = d.arguments && typeof d.arguments === 'object' ? d.arguments : {};
  const text = d.shellToolInfo?.command || a.command || a.path || a.file_path || a.pattern || a.query || a.url || a.question || Object.values(a).find((v) => typeof v === 'string' && v.length < 200) || '';
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 159)}…` : t;
}

// What an approval is for: the command to run, else the file or address, else
// what Copilot says it means to do.
function approvalText(d) {
  const r = d.permissionRequest || d.promptRequest || {};
  const text = r.kind === 'shell' && r.fullCommandText ? `run ${r.fullCommandText}` : r.path || r.url || r.intention || r.toolTitle || r.toolName || r.kind || 'an action';
  return String(text).replace(/\s+/g, ' ').slice(0, 200);
}

// ---- sessions ------------------------------------------------------------------------

const logs = new Map();
let candidates = [];
let scannedAt = 0;

// Sessions that may be open: those in Copilot's open list, and those whose
// folder changed recently.
function findCandidates(now = Date.now()) {
  if (now - scannedAt < RESCAN_MS) return candidates;
  scannedAt = now;
  const ids = new Set();
  try {
    for (const id of Object.keys(JSON.parse(fs.readFileSync(OPEN_FILE, 'utf8')) || {})) if (UUID.test(id)) ids.add(id);
  } catch {}
  let names = [];
  try {
    names = fs.readdirSync(STATE_DIR);
  } catch {}
  for (const n of names) {
    if (!UUID.test(n) || ids.has(n)) continue;
    try {
      if (now - fs.statSync(path.join(STATE_DIR, n)).mtimeMs < RECENT_MS) ids.add(n);
    } catch {}
  }
  candidates = [...ids];
  return candidates;
}

function openState() {
  try {
    return JSON.parse(fs.readFileSync(OPEN_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function readLog(id, used) {
  const file = path.join(STATE_DIR, id, 'events.jsonl');
  let log = logs.get(file);
  if (!log) {
    log = new CopilotLog(file);
    logs.set(file, log);
  }
  used.add(file);
  return log.update() ? log.summary() : null;
}

// A session's state, from its open-list flag and its log: waiting on an
// approval or an answer, working, or idle.
function stateOf(s, open) {
  if (s?.approvals?.length) return { status: 'waiting', waitingFor: `Approval: ${s.approvals[0]}` };
  if (s?.asking?.length) return { status: 'waiting', waitingFor: s.asking[0] ? `Question: ${s.asking[0]}` : 'Your answer' };
  if (open?.working || s?.turnOpen || s?.tools?.length) return { status: 'busy', waitingFor: null };
  return { status: 'idle', waitingFor: null };
}

const since = new Map();

// Copilot sessions as dashboard agents, and their processes, whose windows'
// titles the next snapshot needs.
function snapshot(now = Date.now()) {
  const open = openState();
  const used = new Set();
  const agents = [];
  for (const id of findCandidates(now)) {
    const dir = path.join(STATE_DIR, id);
    const pid = owner(dir);
    if (!pid) continue;
    const ws = readWorkspace(dir) || {};
    const s = readLog(id, used);
    const state = stateOf(s, open[id]);
    const key = `${state.status}:${state.waitingFor}`;
    const prev = since.get(id);
    if (!prev || prev.key !== key) since.set(id, { key, at: now });
    // VS Code's sessions run in its agent host, which has no console to type
    // into and runs every VS Code session, so it isn't stopped from here.
    const vscode = /vscode/i.test(ws.client_name || '');
    agents.push({
      ...(s || {}),
      app: 'copilot',
      id,
      pid,
      title: ws.name || ws.summary || null,
      name: ws.name || ws.summary || path.basename(ws.cwd || '') || 'Copilot',
      cwd: ws.cwd || s?.cwd || null,
      kind: 'interactive',
      entrypoint: vscode ? 'vscode' : 'cli',
      version: s?.version || null,
      status: state.status,
      waitingFor: state.waitingFor,
      statusSince: since.get(id).at,
      startedAt: Date.parse(ws.created_at || '') || Date.parse(open[id]?.openedAt || '') || now,
      terminalTitle: null,
      subagents: NO_SUBAGENTS,
      ...(vscode ? { actions: ['focus'] } : {}),
    });
  }
  for (const file of logs.keys()) if (!used.has(file)) logs.delete(file);
  const live = new Set(agents.map((a) => a.id));
  for (const id of since.keys()) if (!live.has(id)) since.delete(id);
  return { agents, windowPids: agents.map((a) => a.pid) };
}

// The command a new tab runs: Copilot, without its permission prompts if
// Settings says to skip them, starting a session with a given ID and name, or
// resuming one.
function command({ skipPermissions = false, resume = null, sessionId = null, name = null } = {}) {
  const parts = ['copilot'];
  if (skipPermissions) parts.push('--allow-all');
  if (resume) parts.push(`--resume=${resume}`);
  if (sessionId) parts.push(`--session-id=${sessionId}`);
  if (name) parts.push('--name', name);
  return parts.join(' ');
}

// ---- history ----------------------------------------------------------------------

// Session folders with a log changed since `floor`: [{ id, file, mtime, workspace }].
async function sessionFiles(floor) {
  const found = [];
  let names = [];
  try {
    names = await fs.promises.readdir(STATE_DIR);
  } catch {
    return found;
  }
  for (const id of names) {
    if (!UUID.test(id)) continue;
    const file = path.join(STATE_DIR, id, 'events.jsonl');
    try {
      const mtime = (await fs.promises.stat(file)).mtimeMs;
      if (mtime >= floor) found.push({ id, file, mtime, workspace: readWorkspace(path.join(STATE_DIR, id)) || {} });
    } catch {}
  }
  return found;
}

// Whether the Copilot CLI is on this computer: `copilot` on the PATH, or
// where winget or npm put it. VS Code makes ~/.copilot too, so that's no sign.
// Checked at most every half a minute.
let installedAt = 0;
let installedNow = false;
function installed() {
  if (Date.now() - installedAt < 30000) return installedNow;
  const names = process.platform === 'win32' ? ['copilot.exe', 'copilot.cmd'] : ['copilot'];
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'GitHubCopilotCLI'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
  ].filter(Boolean);
  installedNow = dirs.some((dir) => names.some((n) => fs.existsSync(path.join(dir, n))));
  installedAt = Date.now();
  return installedNow;
}

module.exports = { snapshot, command, installed, sessionFiles, CopilotLog, stateOf, readWorkspace, COPILOT_HOME };
