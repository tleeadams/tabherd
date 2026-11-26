'use strict';

const path = require('path');
const { Transcript, clip } = require('./transcript');

// A Codex session file ("rollout"): one JSON object per line, each
// { timestamp, type, payload }. Read the same way as a Claude transcript, a
// few new bytes at a time, into the same summary, so the card is the same.
//
// What's taken from where:
//   session_meta          where and how the session began, its git branch
//   turn_context          the model and approval policy, for each turn
//   event_msg             turns starting and finishing, prompts, replies,
//                         token counts (item_completed in current files;
//                         user_message and agent_message in older ones)
//   response_item         tool calls, paired with their output by call_id
//   compacted             a compaction
//
// The file never records that a session is waiting for an approval; the
// Codex service reports that.

// Lines that are large and carry nothing shown.
const SKIP = /^\{"timestamp":"[^"]*","type":"(world_state|token_usage_record|retained_context|dynamic_tools_updated|security_risk_score|realtime_item)"/;

class Rollout extends Transcript {
  reset() {
    super.reset();
    Object.assign(this.s, {
      originator: null,
      source: null,
      parentThreadId: null,
      version: null,
      approvalPolicy: null,
      contextLimit: 0,
      // The turn running now, which Stop interrupts.
      turnId: null,
    });
  }

  line(line) {
    if (!line || SKIP.test(line)) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const s = this.s;
    const p = e.payload || {};
    if (e.timestamp) {
      s.lastEventAt = e.timestamp;
      s.startedAt = s.startedAt || e.timestamp;
    }
    switch (e.type) {
      case 'session_meta': {
        s.cwd = s.cwd || p.cwd || null;
        s.originator = p.originator || null;
        s.source = p.source ?? null;
        // A subagent whose parent isn't named is still a subagent.
        const sub = subagentOf(p.source);
        s.parentThreadId = p.parent_thread_id || sub?.parentThreadId || (sub ? 'subagent' : null);
        s.version = p.cli_version || null;
        s.startedAt = p.timestamp || s.startedAt;
        if (p.git?.branch && p.git.branch !== 'HEAD') s.gitBranch = p.git.branch;
        break;
      }
      case 'turn_context':
        s.model = p.model || s.model;
        s.approvalPolicy = p.approval_policy || s.approvalPolicy;
        break;
      case 'compacted':
        s.compactions++;
        break;
      case 'response_item':
        this.responseItem(p, e.timestamp);
        break;
      case 'event_msg':
        this.event(p, e.timestamp);
        break;
    }
  }

  event(p, at) {
    const s = this.s;
    switch (p.type) {
      case 'task_started':
        s.turnId = p.turn_id || 'unknown';
        s.tools.clear();
        if (p.model_context_window) s.contextLimit = p.model_context_window;
        break;
      case 'task_complete':
        s.turnId = null;
        s.tools.clear();
        s.lastTurnMs = p.duration_ms ?? null;
        if (p.last_agent_message?.trim()) s.lastReply = { text: clip(p.last_agent_message), at };
        break;
      case 'turn_aborted':
        s.turnId = null;
        s.tools.clear();
        break;
      case 'token_count': {
        const info = p.info;
        if (!info) break;
        if (info.last_token_usage?.total_tokens) s.contextTokens = info.last_token_usage.total_tokens;
        if (info.total_token_usage) s.outputTokens = info.total_token_usage.output_tokens || 0;
        if (info.model_context_window) s.contextLimit = info.model_context_window;
        break;
      }
      case 'item_completed':
        if (p.item?.type === 'UserMessage') this.prompt(texts(p.item.content), at);
        else if (p.item?.type === 'AgentMessage') this.reply(texts(p.item.content), at);
        break;
      case 'user_message':
        this.prompt(p.message, at);
        break;
      case 'agent_message':
        this.reply(p.message, at);
        break;
    }
  }

  responseItem(p, at) {
    const s = this.s;
    switch (p.type) {
      case 'custom_tool_call':
      case 'function_call':
      case 'local_shell_call':
        if (p.call_id) s.tools.set(p.call_id, { ...describeCall(p), at });
        break;
      case 'custom_tool_call_output':
      case 'function_call_output':
      case 'local_shell_call_output':
        s.tools.delete(p.call_id);
        break;
    }
  }

  prompt(text, at) {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) return;
    const s = this.s;
    this.noteTickets(t, 'prompt');
    s.tools.clear();
    s.lastPrompt = { text: clip(t), at };
    s.firstPrompt = s.firstPrompt || s.lastPrompt;
    s.prompts++;
  }

  reply(text, at) {
    if (typeof text !== 'string' || !text.trim()) return;
    this.s.lastReply = { text: clip(text), at };
    this.noteTickets(text, 'reply');
  }

  origin() {
    const { cwd, originator, source, parentThreadId, startedAt } = this.s;
    return { cwd, entrypoint: originator, originator, source, parentThreadId, startedAt };
  }

  summary() {
    const s = this.s;
    return {
      title: null,
      model: s.model,
      modelName: null,
      permissionMode: s.approvalPolicy === 'never' ? 'never-ask' : null,
      gitBranch: s.gitBranch,
      firstPrompt: s.firstPrompt,
      lastPrompt: s.lastPrompt,
      lastReply: s.lastReply,
      recap: null,
      tools: [...s.tools.values()],
      lastEventAt: s.lastEventAt,
      lastTurnMs: s.lastTurnMs,
      contextTokens: s.contextTokens,
      contextLimit: s.contextLimit || 0,
      outputTokens: s.outputTokens,
      prompts: s.prompts,
      compactions: s.compactions,
      prs: [],
      ticketRefs: s.ticketRefs,
      turnOpen: Boolean(s.turnId),
      version: s.version,
    };
  }
}

// A subagent's session says so in its source, in a shape that has changed
// between Codex versions: { subagent: { thread_spawn: { parent_thread_id,
// agent_nickname, agent_role } } }, in either case style. Null if it isn't one.
function subagentOf(source) {
  if (!source || typeof source !== 'object') return null;
  const found = {};
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(o)) {
      const key = k.replace(/_/g, '').toLowerCase();
      if (typeof v === 'string' && key === 'parentthreadid') found.parentThreadId = v;
      else if (typeof v === 'string' && key === 'agentnickname') found.nickname = v;
      else if (typeof v === 'string' && key === 'agentrole') found.role = v;
      else walk(v, depth + 1);
    }
  };
  walk(source, 0);
  const isSub = Object.keys(source).some((k) => k.replace(/_/g, '').toLowerCase() === 'subagent');
  return isSub || found.parentThreadId ? { parentThreadId: found.parentThreadId || null, nickname: found.nickname || null, role: found.role || null } : null;
}

const texts = (content) =>
  Array.isArray(content)
    ? content
        .map((c) => (typeof c?.text === 'string' ? c.text : ''))
        .filter(Boolean)
        .join('\n')
    : typeof content === 'string'
      ? content
      : '';

// What a tool call is doing, for the card's "now" rows. Codex runs most
// commands through a script tool whose input calls tools.exec_command, and
// edits files with apply_patch.
function describeCall(p) {
  const input = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : '';
  const cmd = input.match(/exec_command\(\s*\{\s*cmd\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (cmd) return { name: 'Shell', detail: short(unescape(cmd[1])) };
  const files = [...input.matchAll(/\*\*\* (?:Add|Update|Delete) File: (.+)/g)].map((m) => path.basename(m[1].trim()));
  if (files.length) return { name: 'Edit', detail: short(files.join(', ')) };
  if (p.type === 'local_shell_call') return { name: 'Shell', detail: short([].concat(p.action?.command || []).join(' ')) };
  let args = null;
  try {
    args = JSON.parse(input);
  } catch {}
  if (p.name === 'wait') return { name: 'Waiting on a command', detail: '' };
  const detail = args && typeof args === 'object' ? Object.values(args).find((v) => typeof v === 'string' && v.length < 200) : input.split('\n')[0];
  return { name: p.name || 'Tool', detail: short(detail || '') };
}

function unescape(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

function short(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 159)}…` : t;
}

module.exports = { Rollout, describeCall, subagentOf };
