'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Transcript } = require('./transcript');
const terminals = require('./terminals');
const codex = require('./codex');
const comfy = require('./comfy');
const localai = require('./localai');
const copilot = require('./copilot');
const ollama = require('./ollama');
const lmstudio = require('./lmstudio');
const llamacpp = require('./llamacpp');
const memory = require('./memory');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const IS_WIN = process.platform === 'win32';
const PROC_REFRESH_MS = 10000;
const FINISHED_SUBAGENTS = 5;
const PROCESS_NAMES = /^(claude|node|bun)(\.exe)?$/i;
const NO_SUBAGENTS = { running: [], finished: [], finishedTotal: 0 };

const transcripts = new Map();
const transcriptPaths = new Map();
let procInfo = new Map();
let procInfoAt = 0;
let procInfoPending = null;

// Each running Claude Code session registers itself as sessions/<pid>.json.
// The <pid>.<hash>.key files beside them hold secrets and are never opened.
// A file caught while it's being rewritten keeps its last reading, so the
// session doesn't drop off the dashboard for a moment and look finished.
const lastRead = new Map();

function readRegistry() {
  let names;
  try {
    names = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  const records = [];
  const seen = new Set();
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    seen.add(name);
    let rec = null;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8'));
      lastRead.set(name, rec);
    } catch {
      rec = lastRead.get(name) || null;
    }
    if (rec && Number.isInteger(rec.pid) && rec.pid > 0) records.push(rec);
  }
  for (const name of lastRead.keys()) if (!seen.has(name)) lastRead.delete(name);
  return records;
}

// Run headless, with `claude -p` (entrypoint sdk-cli) or the Agent SDK, so
// there's no window to go to or type into. Claude registers these as
// interactive too.
const isBackground = (rec) => /^sdk-/.test(rec.entrypoint || '');

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err && !stdout ? null : String(stdout)),
    );
  });
}

// Name, start time and memory for the given PIDs. On Windows the start time is
// a FILETIME, the same unit Claude Code records as procStart.
async function queryProcesses(pids) {
  const info = new Map();
  if (!pids.length) return info;
  if (IS_WIN) {
    const script =
      `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { ` +
      `'{0}|{1}|{2}|{3}' -f $_.Id, $_.ProcessName, $(try { $_.StartTime.ToFileTimeUtc() } catch { '' }), $_.WorkingSet64 }`;
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (out === null) return null;
    for (const line of out.split(/\r?\n/)) {
      const [pid, name, start, ws] = line.trim().split('|');
      if (!pid) continue;
      info.set(Number(pid), { name, start: start ? Number(start) : null, memBytes: Number(ws) || null });
    }
  } else {
    const out = await run('ps', ['-o', 'pid=,rss=,comm=', '-p', pids.join(',')]);
    if (out === null) return null;
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (m) info.set(Number(m[1]), { name: path.basename(m[3]), start: null, memBytes: Number(m[2]) * 1024 });
    }
    // Node 24 on Linux names its main thread MainThread, and ps gives that as
    // the process's name. The program it was started as says what it is.
    const unnamed = [...info].filter(([, p]) => !PROCESS_NAMES.test(p.name)).map(([pid]) => pid);
    if (unnamed.length) {
      const args = (await run('ps', ['-o', 'pid=,args=', '-p', unnamed.join(',')])) || '';
      for (const line of args.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\S+)/);
        const name = m ? path.basename(m[2]) : '';
        if (PROCESS_NAMES.test(name)) info.get(Number(m[1])).name = name;
      }
    }
  }
  return info;
}

async function refreshProcInfo(pids) {
  const known = pids.every((pid) => procInfo.has(pid));
  if (known && Date.now() - procInfoAt < PROC_REFRESH_MS) return;
  if (!procInfoPending) {
    procInfoPending = queryProcesses(pids).then((info) => {
      if (info) {
        procInfo = info;
        procInfoAt = Date.now();
      }
      procInfoPending = null;
    });
  }
  // New PIDs must be checked before they are shown; memory refreshes can lag.
  if (!known) await procInfoPending;
}

// A registry file outlives a crashed session, and Windows reuses PIDs, so a
// live PID only counts when the process is Claude and started when the file says.
function isSameProcess(rec) {
  const p = procInfo.get(rec.pid);
  if (!p) return true;
  if (!PROCESS_NAMES.test(p.name)) return false;
  const recorded = Number(rec.procStartFt ?? rec.procStart);
  if (!IS_WIN || !p.start || !Number.isFinite(recorded)) return true;
  return Math.abs(p.start - recorded) < 2e7;
}

function findTranscript(rec) {
  if (!rec.sessionId || !rec.cwd) return null;
  const cached = transcriptPaths.get(rec.sessionId);
  if (cached && fs.existsSync(cached)) return cached;
  const file = `${rec.sessionId}.jsonl`;
  const direct = path.join(PROJECTS_DIR, rec.cwd.replace(/[^a-zA-Z0-9]/g, '-'), file);
  let found = fs.existsSync(direct) ? direct : null;
  if (!found) {
    // Very long paths are shortened when they become folder names, so search.
    try {
      for (const dir of fs.readdirSync(PROJECTS_DIR)) {
        const candidate = path.join(PROJECTS_DIR, dir, file);
        if (fs.existsSync(candidate)) {
          found = candidate;
          break;
        }
      }
    } catch {}
  }
  if (found) transcriptPaths.set(rec.sessionId, found);
  return found;
}

function readTranscript(file, used) {
  let t = transcripts.get(file);
  if (!t) {
    t = new Transcript(file);
    transcripts.set(file, t);
  }
  used.add(file);
  return t.update() ? t.summary() : null;
}

function readSubagents(transcriptFile, rec, used) {
  const dir = path.join(path.dirname(transcriptFile), rec.sessionId, 'subagents');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return NO_SUBAGENTS;
  }
  const running = [];
  const finished = [];
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue;
    const id = name.slice(0, -'.meta.json'.length);
    const jsonl = path.join(dir, `${id}.jsonl`);
    let meta;
    let mtime;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      mtime = fs.statSync(jsonl).mtimeMs;
    } catch {
      continue;
    }
    const agent = {
      id: id.replace(/^agent-/, ''),
      type: meta.agentType || 'agent',
      description: meta.description || '',
      background: meta.requestShape === 'background',
      updatedAt: mtime,
    };
    // A subagent left unfinished by an earlier run of a resumed session is not running.
    if (!meta.finished && mtime >= (rec.startedAt || 0)) {
      const s = readTranscript(jsonl, used);
      running.push({
        ...agent,
        status: 'running',
        startedAt: s?.firstPrompt?.at || null,
        tools: s?.tools || [],
        lastReply: s?.lastReply || null,
        outputTokens: s?.outputTokens || 0,
      });
    } else {
      finished.push({ ...agent, status: meta.finished ? 'done' : 'stopped' });
    }
  }
  finished.sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    running: running.sort((a, b) => b.updatedAt - a.updatedAt),
    finished: finished.slice(0, FINISHED_SUBAGENTS),
    finishedTotal: finished.length,
  };
}

async function snapshot() {
  const records = readRegistry().filter((rec) => isRunning(rec.pid));
  await refreshProcInfo(records.map((rec) => rec.pid));
  const used = new Set();
  const agents = [];
  for (const rec of records) {
    if (!isSameProcess(rec)) continue;
    const file = findTranscript(rec);
    const t = file ? readTranscript(file, used) : null;
    agents.push({
      app: 'claude',
      id: rec.sessionId,
      pid: rec.pid,
      name: rec.name || path.basename(rec.cwd || '') || `pid ${rec.pid}`,
      cwd: rec.cwd,
      kind: rec.kind,
      entrypoint: rec.entrypoint,
      background: isBackground(rec),
      version: rec.version,
      status: rec.status || 'unknown',
      waitingFor: rec.waitingFor || null,
      detail: typeof rec.detail === 'string' ? rec.detail : null,
      statusSince: rec.statusUpdatedAt || rec.updatedAt || rec.startedAt,
      startedAt: rec.startedAt,
      memBytes: procInfo.get(rec.pid)?.memBytes ?? null,
      terminalTitle: terminals.titleFor(rec.pid),
      ...(t || {}),
      subagents: file ? readSubagents(file, rec, used) : NO_SUBAGENTS,
    });
  }
  for (const file of transcripts.keys()) if (!used.has(file)) transcripts.delete(file);
  // Codex's windows have their titles read too: that's how each is matched
  // to its session.
  const fromCodex = codex.snapshot();
  agents.push(...fromCodex.agents);
  // GitHub Copilot's sessions, from the CLI and VS Code.
  const fromCopilot = copilot.snapshot();
  agents.push(...fromCopilot.agents);
  // ComfyUI's jobs, and Comfy Desktop's windows, whose titles give the
  // running job's progress.
  const fromComfy = comfy.snapshot();
  agents.push(...fromComfy.items);
  // LocalAI's loaded models, downloads, agent chats and agent jobs.
  agents.push(...localai.snapshot());
  // Ollama's, LM Studio's and llama.cpp's loaded models.
  agents.push(...ollama.snapshot(), ...lmstudio.snapshot(), ...llamacpp.snapshot());
  terminals.refreshTitles([
    ...agents.filter((a) => a.app === 'claude' && !a.background && (!a.kind || a.kind === 'interactive')).map((a) => a.pid),
    ...fromCodex.windowPids,
    ...fromCopilot.agents.filter((a) => a.entrypoint === 'cli').map((a) => a.pid),
    ...fromComfy.windowPids,
  ]);
  // How each ComfyUI job that just finished ended, and its output, for the
  // notification its leaving brings.
  return {
    now: Date.now(),
    host: os.hostname(),
    home: os.homedir(),
    platform: process.platform,
    agents,
    finished: fromComfy.finished,
    // RAM and graphics memory, for the card at the top.
    memory: memory.snapshot(),
  };
}

async function findAgent(sessionId) {
  const snap = await snapshot();
  return snap.agents.find((a) => a.id === sessionId) || null;
}

const sessionFile = (pid) => path.join(SESSIONS_DIR, `${pid}.json`);

module.exports = { snapshot, findAgent, sessionFile, PROJECTS_DIR };
