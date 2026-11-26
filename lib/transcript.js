'use strict';

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const ticketRefs = require('./ticket-refs');

const CHUNK = 4 * 1024 * 1024;
const TEXT_MAX = 600;
const MAX_TICKET_REFS = 500;

// Claude Code appends one JSON object per line. Each update() reads only the
// bytes added since the last call, so polling a long transcript stays cheap.
class Transcript {
  constructor(file) {
    this.file = file;
    this.reset();
  }

  reset() {
    this.offset = 0;
    this.carry = '';
    this.decoder = new StringDecoder('utf8');
    this.lastMsgId = null;
    this.lastMsgOut = 0;
    this.s = {
      cwd: null,
      entrypoint: null,
      startedAt: null,
      title: null,
      customTitle: null,
      model: null,
      modelName: null,
      permissionMode: null,
      gitBranch: null,
      firstPrompt: null,
      lastPrompt: null,
      lastReply: null,
      recap: null,
      tools: new Map(),
      lastEventAt: null,
      lastTurnMs: null,
      contextTokens: 0,
      outputTokens: 0,
      prompts: 0,
      compactions: 0,
      prs: new Map(),
      // Tickets claimed, given up and (in prompts) linked, in order.
      ticketRefs: [],
    };
  }

  // Notes the tickets a prompt or reply claims, gives up or links. Every
  // reader calls it with each one's whole text, before it's shortened.
  noteTickets(text, from) {
    const found = ticketRefs.find(text, from);
    if (!found.length) return;
    const list = this.s.ticketRefs;
    list.push(...found);
    if (list.length > MAX_TICKET_REFS) list.splice(0, list.length - MAX_TICKET_REFS);
  }

  update() {
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return false;
    }
    if (size < this.offset) this.reset();
    if (size === this.offset) return true;

    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - this.offset));
      while (this.offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        const lines = (this.carry + this.decoder.write(buf.subarray(0, n))).split('\n');
        this.carry = lines.pop();
        for (const line of lines) this.line(line);
      }
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }

  line(line) {
    // Request snapshots are the largest lines and carry nothing we display.
    if (!line || line.startsWith('{"type":"api-request')) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const s = this.s;
    if (e.timestamp && e.type !== 'queue-operation') {
      s.lastEventAt = e.timestamp;
      s.startedAt = s.startedAt || e.timestamp;
    }
    s.cwd = s.cwd || e.cwd || null;
    s.entrypoint = s.entrypoint || e.entrypoint || null;
    if (e.gitBranch && e.gitBranch !== 'HEAD') s.gitBranch = e.gitBranch;

    switch (e.type) {
      case 'ai-title':
        s.title = e.aiTitle || s.title;
        break;
      case 'custom-title':
        s.customTitle = e.customTitle || s.customTitle;
        break;
      case 'permission-mode':
        s.permissionMode = e.permissionMode || s.permissionMode;
        break;
      case 'pr-link':
        if (e.prUrl) s.prs.set(e.prUrl, { url: e.prUrl, number: e.prNumber, repo: e.prRepository });
        break;
      case 'attachment':
        if (e.attachment?.type === 'model' && e.attachment.identity) {
          s.model = e.attachment.identity.modelId || s.model;
          s.modelName = e.attachment.identity.marketingName || null;
        }
        break;
      case 'system':
        if (e.subtype === 'turn_duration') {
          s.tools.clear();
          s.lastTurnMs = e.durationMs ?? null;
        } else if (e.subtype === 'away_summary' && typeof e.content === 'string') {
          s.recap = { text: clip(e.content.replace(/\s*\(disable recaps in \/config\)\s*$/, '')), at: e.timestamp };
        } else if (e.subtype === 'compact_boundary') {
          s.compactions++;
        }
        break;
      case 'user':
        this.user(e);
        break;
      case 'assistant':
        this.assistant(e);
        break;
    }
  }

  user(e) {
    const s = this.s;
    const content = e.message?.content;
    let text = null;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const parts = [];
      for (const b of content) {
        if (b.type === 'tool_result') s.tools.delete(b.tool_use_id);
        else if (b.type === 'text') parts.push(b.text);
      }
      if (parts.length) text = parts.join('\n');
    }
    if (text === null || e.isMeta || e.isCompactSummary) return;
    const prompt = cleanPrompt(text);
    if (!prompt) return;
    // Not what Claude Code adds, nor text pasted in from elsewhere.
    this.noteTickets(text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>|<pasted_content[^>]*>[\s\S]*?<\/pasted_content>/g, ''), 'prompt');
    s.tools.clear();
    s.lastPrompt = { text: prompt, at: e.timestamp };
    s.firstPrompt = s.firstPrompt || s.lastPrompt;
    s.prompts++;
  }

  assistant(e) {
    const s = this.s;
    const m = e.message;
    if (!m) return;
    if (m.model && m.model !== '<synthetic>' && m.model !== baseModel(s.model)) {
      s.model = m.model;
      s.modelName = null;
    }
    const u = m.usage;
    if (u) {
      const out = u.output_tokens || 0;
      s.contextTokens =
        (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + out;
      // A response is logged once per content block, each line repeating the usage.
      if (m.id && m.id === this.lastMsgId) s.outputTokens += out - this.lastMsgOut;
      else s.outputTokens += out;
      this.lastMsgId = m.id;
      this.lastMsgOut = out;
    }
    if (!Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        s.tools.set(b.id, { name: toolName(b.name), detail: describeTool(b.name, b.input), at: e.timestamp });
      } else if (b.type === 'text' && b.text?.trim()) {
        s.lastReply = { text: clip(b.text), at: e.timestamp };
        this.noteTickets(b.text, 'reply');
      }
    }
  }

  // Where and how the session began, for reading a transcript after its
  // session has closed. Kept out of summary(), which is merged over the
  // session registry's own values.
  origin() {
    const { cwd, entrypoint, startedAt } = this.s;
    return { cwd, entrypoint, startedAt };
  }

  summary() {
    const s = this.s;
    const ctxLimit = /\[1m\]/i.test(s.model || '') || s.contextTokens > 200000 ? 1000000 : 200000;
    return {
      title: s.customTitle || s.title,
      model: s.model,
      modelName: s.modelName,
      permissionMode: s.permissionMode,
      gitBranch: s.gitBranch,
      firstPrompt: s.firstPrompt,
      lastPrompt: s.lastPrompt,
      lastReply: s.lastReply,
      recap: s.recap,
      tools: [...s.tools.values()],
      lastEventAt: s.lastEventAt,
      lastTurnMs: s.lastTurnMs,
      contextTokens: s.contextTokens,
      contextLimit: ctxLimit,
      outputTokens: s.outputTokens,
      prompts: s.prompts,
      compactions: s.compactions,
      prs: [...s.prs.values()],
      ticketRefs: s.ticketRefs,
    };
  }
}

function cleanPrompt(raw) {
  let t = String(raw).trim();
  if (/^<(task-notification|local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/.test(t)) {
    return null;
  }
  if (/^\[Request interrupted by user/.test(t)) return null;
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
    t = `${cmd[1].trim()} ${args ? args[1].trim() : ''}`;
  }
  const bash = t.match(/^<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bash) t = `! ${bash[1]}`;
  t = t
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content>/g, '[pasted text]')
    .trim();
  return t ? clip(t) : null;
}

function clip(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t;
}

function baseModel(id) {
  return id ? id.replace(/\[[^\]]*\]$/, '') : id;
}

function toolName(name) {
  if (!name?.startsWith('mcp__')) return name;
  const [server, ...rest] = name.slice(5).split('__');
  return `${server.replace(/^claude_ai_/, '').replace(/_/g, ' ')}: ${rest.join('__')}`;
}

function describeTool(name, input) {
  const i = input || {};
  const base = (p) => (p ? path.basename(String(p)) : '');
  let d;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      d = i.description || i.command;
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      d = base(i.file_path || i.notebook_path);
      break;
    case 'Grep':
    case 'Glob':
      d = i.pattern;
      break;
    case 'Agent':
    case 'Task':
      d = i.description || i.subagent_type;
      break;
    case 'WebFetch':
      d = i.url;
      break;
    case 'WebSearch':
      d = i.query;
      break;
    case 'Skill':
      d = i.skill;
      break;
    case 'AskUserQuestion':
      d = i.questions?.[0]?.question;
      break;
    default:
      d = Object.values(i).find((v) => typeof v === 'string' && v.length < 200);
  }
  if (!d) return '';
  const t = String(d).replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 159)}…` : t;
}

module.exports = { Transcript, clip };
