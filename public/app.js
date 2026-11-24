'use strict';

let token = document.querySelector('meta[name="agents-token"]').content;

// Settings this browser saved before the project was renamed Tabherd, under
// its old name, move to the new one.
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('claude-agents:')) continue;
    const renamed = `tabherd:${key.slice('claude-agents:'.length)}`;
    if (localStorage.getItem(renamed) === null) localStorage.setItem(renamed, localStorage.getItem(key));
    localStorage.removeItem(key);
  }
} catch {}

const STATUS = {
  waiting: { label: 'Needs you', group: 'needs', rank: 0 },
  busy: { label: 'Working', group: 'working', rank: 1 },
  shell: { label: 'Shell running', group: 'working', rank: 2, hint: 'At the prompt while a background shell task runs' },
  // A ComfyUI job or a download waiting its turn.
  queued: { label: 'Queued', group: 'working', rank: 3, hint: 'Waiting for the ones before it' },
  idle: { label: 'Idle', group: 'idle', rank: 4 },
  unknown: { label: 'Starting', group: 'idle', rank: 5 },
  // A model loaded in LocalAI: not anyone's turn, so in no filter but All.
  loaded: { label: 'Loaded', group: 'resource', rank: 6 },
};
// Filters that cover more than one status group. Todo is every agent whose
// turn it is, and the to-do cards too.
const FILTER_GROUPS = { todo: ['needs', 'idle'] };
const PERMISSION_MODES = {
  bypassPermissions: 'bypass',
  acceptEdits: 'accept edits',
  plan: 'plan mode',
  auto: 'auto',
  dontAsk: "don't ask",
  'never-ask': 'never asks',
};
// Which app each session is, on its card and in the history.
const APPS = { claude: 'Claude', codex: 'Codex', comfy: 'Comfy', localai: 'LocalAI' };
// Cards for things other than sessions: ComfyUI's jobs, and LocalAI's
// models, downloads and chats.
const isItem = (a) => a.app === 'comfy' || a.app === 'localai';
const APP_HINTS = { claude: 'A Claude Code session', codex: 'A Codex session', comfy: 'A ComfyUI job', localai: 'From LocalAI' };
const appTag = (x) => el('span', { class: `app app-${x.app || 'claude'}`, title: APP_HINTS[x.app] || APP_HINTS.claude }, APPS[x.app] || APPS.claude);
// The colours a group can have, as the server knows them. Each is set for
// light and dark in the stylesheet, as .g-<name>.
const GROUP_COLORS = { rose: 'Rose', orange: 'Orange', olive: 'Olive', teal: 'Teal', indigo: 'Indigo', plum: 'Plum', brown: 'Brown', slate: 'Slate' };

const $ = (id) => document.getElementById(id);
const list = $('list');
const cards = new Map();
const subsOpen = new Map();
const expanded = new Set();
let filter = 'all';
let snap = null;
let clockSkew = 0;

// ---- helpers ---------------------------------------------------------------

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

// Enter in a text box would otherwise submit the Settings form, which closes it.
const noSubmit = (then) => (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  then?.(e.currentTarget);
};

const now = () => Date.now() + clockSkew;
const ms = (t) => (typeof t === 'number' ? t : t ? Date.parse(t) : NaN);

function dur(delta) {
  const s = Math.max(0, Math.floor(delta / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function since(t, suffix = '') {
  const at = ms(t);
  if (!Number.isFinite(at)) return null;
  return el('span', { class: 'since', 'data-since': at, 'data-suffix': suffix, title: new Date(at).toLocaleString() }, dur(now() - at) + suffix);
}

function tick() {
  for (const node of document.querySelectorAll('[data-since]')) {
    node.textContent = dur(now() - Number(node.dataset.since)) + node.dataset.suffix;
  }
}

function tokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${n < 1e4 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') : Math.round(n / 1e3)}k`;
  return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
}

function modelLabel(a) {
  if (a.modelName) return a.modelName.replace(/ \((1M) context\)$/, ' · $1');
  const m = (a.model || '').match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : a.model;
}

function shortPath(p) {
  if (!p) return '';
  const home = snap?.home || repoData?.home;
  return home && p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p;
}

const status = (a) => STATUS[a.status] || STATUS.unknown;
// What the terminal tab shows, falling back to Claude's own names.
const displayName = (a) => a.terminalTitle || a.title || a.name;
const resumeCommand = (a) => `cd "${a.cwd}"; ${a.app === 'codex' ? 'codex resume' : 'claude --resume'} ${a.id}`;

function toast(message, isError) {
  const t = $('toast');
  t.textContent = message;
  t.className = `toast show${isError ? ' error' : ''}`;
  // A popover shows above dialogs opened before it, so it's opened again for
  // each message, in front of whichever dialog is open now.
  if (t.showPopover) {
    if (t.matches(':popover-open')) t.hidePopover();
    t.showPopover();
  }
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = 'toast'), isError ? 5000 : 2200);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el('textarea', { readonly: true });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

// Each server run has its own token. A page left open while the server
// restarted gets the new one and tries again; the server did nothing with the
// refused request.
async function api(url, body) {
  const request = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'X-Agents-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  let res = await request();
  if (res.status === 403 && (await renewToken())) res = await request();
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Reads the token from a fresh copy of the page. True if it changed.
async function renewToken() {
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    const fresh = new DOMParser().parseFromString(html, 'text/html').querySelector('meta[name="agents-token"]')?.content;
    if (!fresh || fresh === token) return false;
    token = fresh;
    return true;
  } catch {
    return false;
  }
}

const post = (agent, action) => api(`/api/agents/${encodeURIComponent(agent.id)}/${action}`);

// The server says whether this computer has a terminal it can drive. A Codex
// session's window is known once its tab's title names it.
// A background run, with `claude -p`, has no window.
// Other apps' cards say which buttons they have.
const canFocus = (a) =>
  Boolean(snap?.terminals) && !a.background && Boolean(a.pid) && (a.actions ? a.actions.includes('focus') : !a.kind || a.kind === 'interactive');
// Codex takes Catch up's prompt through its own service, so it doesn't need
// the window; Claude's is typed into the window.
const canCatchUp = (a) => (a.app === 'codex' ? !a.kind || a.kind === 'interactive' : canFocus(a));
// The app a to-do starts: its own choice, or the one Settings names.
const todoApp = (t) => t.app || snap?.newSessionApp || 'claude';

async function goToWindow(a, button) {
  if (button) button.disabled = true;
  try {
    const r = await post(a, 'focus');
    if (r.terminal && !r.tab) toast(`Opened ${r.window}, but couldn't tell which tab is ${displayName(a)}`, true);
    else if (!r.raised) toast(`Found ${r.terminal ? 'the tab' : r.window}, but Windows kept it in the background. Check the taskbar.`, true);
    else toast(r.terminal ? `Switched to ${displayName(a)}` : `Opened ${r.window}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function catchUp(a, button) {
  button.disabled = true;
  try {
    const r = await post(a, 'catch-up');
    // A Codex session's window may not be known, which isn't worth a mention.
    const where = r.raised || (a.app === 'codex' && !a.pid) ? '' : ' Its window stayed in the background.';
    const after = a.app === 'codex' ? 'turn' : 'step';
    toast(
      a.status === 'busy'
        ? `Queued for ${displayName(a)}. It will answer after its current ${after}.${where}`
        : `Asked ${displayName(a)} to catch you up.${where}`,
    );
    refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

// ---- groups ------------------------------------------------------------------

// The server says which group each session and to-do is in, and whether it
// was put there by hand (`placed`) or is there by its folder.
const groupDef = (id) => (id && (snap?.groups || []).find((g) => g.id === id)) || null;

// The group button on a card. Without a group it reads "No group" and only
// shows while the card is pointed at or focused.
function groupChip(x, cwd) {
  const g = groupDef(x.group);
  const how = x.placed ? 'put there by hand' : 'by its folder';
  return el(
    'button',
    {
      type: 'button',
      class: g ? `group-chip g-${g.color}` : 'group-chip none',
      title: g ? `In ${g.name}, ${how}. Click to change.` : `In no group${x.placed ? ', put there by hand' : ''}. Click to choose one.`,
      'aria-haspopup': 'menu',
      onclick: (e) => openGroupMenu(x, cwd, e.currentTarget),
    },
    el('span', { class: 'dot' }),
    g ? g.name : 'No group',
  );
}

// The group's name in its colour, where it can't be changed, as in History.
function groupTag(x) {
  const g = groupDef(x.group);
  return g ? el('span', { class: `group-chip static g-${g.color}`, title: `In ${g.name}` }, el('span', { class: 'dot' }), g.name) : null;
}

async function placeIn(x, group) {
  try {
    await api('/api/groups/place', { id: x.id, group });
    const g = groupDef(group);
    toast(group === 'auto' ? 'Following its folder again' : g ? `Moved to ${g.name}` : 'Moved out of its group');
  } catch (err) {
    toast(err.message, true);
  }
  refresh();
}

// The next colour no group has yet, so new groups look different.
function freeColor(groups) {
  const used = new Set(groups.map((g) => g.color));
  return Object.keys(GROUP_COLORS).find((c) => !used.has(c)) || Object.keys(GROUP_COLORS)[groups.length % 8];
}

const baseName = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';

// The menu under a card's group button: each group, No group, Follow its
// folder again (once moved by hand), a new group for the card's folder, and
// the group settings.
function openGroupMenu(x, cwd, button) {
  const menu = $('group-menu');
  const groups = snap?.groups || [];
  const close = () => menu.hidePopover();
  const item = (label, checked, onclick, extra = {}) =>
    el('button', { type: 'button', class: 'menu-item', role: checked === null ? 'menuitem' : 'menuitemradio', 'aria-checked': checked === null ? null : String(checked), onclick, ...extra }, label);
  const choose = (group) => () => {
    close();
    placeIn(x, group);
  };
  const name = el('input', { type: 'text', value: baseName(cwd), maxlength: '40', 'aria-label': 'New group name', autocomplete: 'off', spellcheck: 'false' });
  const create = async (e) => {
    e.preventDefault();
    const g = { id: crypto.randomUUID(), name: name.value.trim(), color: freeColor(groups), folders: [cwd] };
    if (!g.name) return name.focus();
    try {
      await api('/api/groups', { groups: [...groups, g] });
      // Moved by hand before, it now follows its folder into the new group.
      if (x.placed) await api('/api/groups/place', { id: x.id, group: 'auto' });
      close();
      toast(`Made ${g.name} for ${shortPath(cwd)}`);
    } catch (err) {
      toast(err.message, true);
    }
    refresh();
  };
  const items = [
    ...groups.map((g) => item([el('span', { class: `dot g-${g.color}` }), g.name], x.group === g.id, choose(g.id))),
    item([el('span', { class: 'dot none' }), 'No group'], !x.group, choose(null)),
    x.placed ? item('Follow its folder again', null, choose('auto'), { title: 'Go back to the group its folder is in' }) : null,
    el('hr'),
    cwd
      ? el(
          'form',
          { class: 'menu-new', onsubmit: create },
          el('label', { text: `New group for ${shortPath(cwd)}` }),
          el('div', { class: 'menu-new-row' }, name, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Make')),
        )
      : null,
    item('Edit groups…', null, () => {
      close();
      openSettings('groups-setting');
    }),
  ];
  menu.replaceChildren(...items.filter(Boolean));
  menu.showPopover();
  // Under the button, kept on screen.
  const r = button.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  menu.querySelector('[aria-checked="true"]')?.focus();
}

// ---- card ------------------------------------------------------------------

// Text cut to two lines that a click expands. `id` remembers it across updates.
function expandable(id, text) {
  return el('p', {
    class: 'text',
    text,
    tabindex: '0',
    title: 'Click to expand',
    onclick: (e) => {
      const box = e.currentTarget.parentElement;
      box.classList.toggle('expanded');
      if (box.classList.contains('expanded')) expanded.add(id);
      else expanded.delete(id);
    },
    onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), e.currentTarget.click()),
  });
}

function message(a, key, label, m, cls) {
  const id = `${a.id}:${key}`;
  return el(
    'div',
    { class: `msg ${cls || ''}${expanded.has(id) ? ' expanded' : ''}` },
    el('span', { class: 'label' }, m.at ? [`${label} · `, since(m.at, ' ago')] : label),
    expandable(id, m.text),
  );
}

// On a session started from a to-do: the to-do, and a way to copy it into Claude.
function todoNote(a) {
  const t = a.todo;
  if (!t) return null;
  const id = `${a.id}:todo`;
  return el(
    'div',
    { class: `msg todo-text todo-msg${expanded.has(id) ? ' expanded' : ''}` },
    el(
      'div',
      { class: 'todo-msg-head' },
      el('span', { class: 'label', text: 'To-do' }),
      el('b', { class: 'todo-msg-title', text: t.title, title: t.title }),
      el('button', { type: 'button', class: 'link-btn', title: 'Copy the title and notes, to paste into Claude', onclick: () => copyTodo(t) }, 'Copy'),
    ),
    t.notes ? expandable(id, t.notes) : null,
  );
}

function nowBlock(a) {
  const rows = [];
  if (a.status === 'waiting') {
    rows.push(el('div', { class: 'now-row' }, el('span', { class: 'what', text: 'Waiting on you' }), el('span', { class: 'detail', text: a.waitingFor || '' })));
  }
  for (const t of a.tools || []) {
    rows.push(el('div', { class: 'now-row' }, el('span', { class: 'what', text: t.name }), el('span', { class: 'detail', text: t.detail, title: t.detail }), since(t.at)));
  }
  const runningSubs = a.subagents?.running.length || 0;
  if (a.status === 'busy' && !a.tools?.length) {
    const what = runningSubs ? 'Waiting on subagents' : 'Thinking';
    const detail = runningSubs ? `${runningSubs} running` : '';
    rows.push(el('div', { class: 'now-row' }, el('span', { class: 'what', text: what }), el('span', { class: 'detail', text: detail }), since(a.lastEventAt)));
  }
  if (a.status === 'shell' && !a.tools?.length) {
    rows.push(el('div', { class: 'now-row' }, el('span', { class: 'what', text: 'Background shell' }), el('span', { class: 'detail', text: 'running while the session waits at the prompt' })));
  }
  if (a.detail) rows.push(el('div', { class: 'now-row' }, el('span', { class: 'detail', text: a.detail })));
  return rows.length ? el('div', { class: `now${a.status === 'waiting' ? ' waiting' : ''}` }, rows) : null;
}

function activity(a) {
  const promptAt = ms(a.lastPrompt?.at) || 0;
  const parts = [todoNote(a), nowBlock(a)];
  const replyFresh = a.lastReply && ms(a.lastReply.at) >= promptAt;
  const recapFresh = a.recap && ms(a.recap.at) >= Math.max(promptAt, replyFresh ? ms(a.lastReply.at) : 0);
  if (recapFresh && a.status !== 'busy') parts.push(message(a, 'recap', 'Recap', a.recap));
  else if (replyFresh) parts.push(message(a, 'reply', a.status === 'busy' ? 'Latest update' : 'Last reply', a.lastReply));
  if (a.lastPrompt) parts.push(message(a, 'prompt', 'Last prompt', a.lastPrompt, 'prompt'));
  return el('div', { class: 'activity' }, parts);
}

function stats(a) {
  const items = [];
  if (a.model) items.push(el('span', { class: 'model', text: modelLabel(a), title: a.model }));
  if (a.contextTokens) {
    const pct = Math.min(100, (a.contextTokens / a.contextLimit) * 100);
    const fill = el('i');
    fill.style.width = `${pct.toFixed(1)}%`;
    items.push(
      el(
        'span',
        { class: 'ctx', title: `Context: ${a.contextTokens.toLocaleString()} of ${a.contextLimit.toLocaleString()} tokens` },
        el('span', { class: `bar${pct > 85 ? ' high' : pct > 60 ? ' mid' : ''}` }, fill),
        `${tokens(a.contextTokens)} / ${tokens(a.contextLimit)} context`,
      ),
    );
  }
  if (a.outputTokens) items.push(el('span', { title: 'Output tokens generated this session', text: `${tokens(a.outputTokens)} out` }));
  if (a.prompts) items.push(el('span', { text: `${a.prompts} prompt${a.prompts === 1 ? '' : 's'}` }));
  if (a.compactions) items.push(el('span', { text: `${a.compactions} compaction${a.compactions === 1 ? '' : 's'}` }));
  return items.length ? el('div', { class: 'stats' }, items) : null;
}

function subagents(a) {
  const s = a.subagents;
  if (!s || (!s.running.length && !s.finishedTotal)) return null;
  const open = subsOpen.has(a.id) ? subsOpen.get(a.id) : s.running.length > 0;
  const summary = [`Subagents · ${s.running.length} running`];
  if (s.finishedTotal) summary.push(` · ${s.finishedTotal} finished`);
  const rows = [
    ...s.running.map((sub) => {
      const tool = sub.tools[sub.tools.length - 1];
      return el(
        'li',
        { class: 'sub running' },
        el('span', { class: 'dot' }),
        el('span', { class: 'type', text: sub.type }),
        el('span', { class: 'desc', text: sub.description, title: sub.description }),
        since(sub.startedAt),
        el('span', { class: 'tool', text: tool ? `${tool.name} · ${tool.detail}` : sub.lastReply?.text || 'Thinking…' }),
      );
    }),
    ...s.finished.map((sub) =>
      el(
        'li',
        { class: `sub ${sub.status}`, title: sub.status === 'done' ? 'Finished' : 'Ended without finishing' },
        el('span', { class: 'dot' }),
        el('span', { class: 'type', text: sub.type }),
        el('span', { class: 'desc', text: sub.description, title: sub.description }),
        since(sub.updatedAt, ' ago'),
      ),
    ),
  ];
  const more = s.finishedTotal - s.finished.length;
  return el(
    'details',
    {
      class: 'subs',
      open,
      ontoggle: (e) => subsOpen.set(a.id, e.currentTarget.open),
    },
    el('summary', {}, summary.join('')),
    el('ul', {}, rows),
    more > 0 ? el('p', { class: 'more', text: `and ${more} more finished` }) : null,
  );
}

function actions(a) {
  const btn = (label, onclick, cls = '', props = {}) => el('button', { type: 'button', class: `btn ${cls}`, onclick, ...props }, label);
  const waiting = a.status === 'waiting';
  return el(
    'div',
    { class: 'actions' },
    canFocus(a) ? btn('Go to window', (e) => goToWindow(a, e.currentTarget), 'btn-primary') : null,
    canCatchUp(a)
      ? btn('Catch up', (e) => catchUp(a, e.currentTarget), 'btn-accent', {
          disabled: waiting,
          title: waiting
            ? 'Waiting on a prompt or dialog. Answer it with Go to window first.'
            : 'Go to the window and ask where things stand',
        })
      : null,
    btn('Open folder', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await post(a, 'open-folder');
        toast(`Opened ${shortPath(a.cwd)}`);
      } catch (err) {
        toast(err.message, true);
      } finally {
        b.disabled = false;
      }
    }),
    btn('Copy resume command', async () => {
      await copy(resumeCommand(a));
      toast('Resume command copied');
    }),
    btn('Stop…', () => confirmStop(a), 'btn-stop'),
  );
}

// A card for a ComfyUI job, or a LocalAI model, download or chat. The server
// gives what it shows, `facts` as label and value pairs, and which buttons it
// has, as `actions`.
function itemCard(a) {
  const st = status(a);
  const can = (action) => (a.actions || []).includes(action);
  const btn = (label, onclick, cls = '', props = {}) => el('button', { type: 'button', class: `btn ${cls}`, onclick, ...props }, label);
  const proc = [a.pid && !isItem(a) ? `PID ${a.pid}` : null, a.memBytes ? `${Math.round(a.memBytes / 1048576)} MB` : null].filter(Boolean);
  const pct = a.progress ? Math.max(0, Math.min(100, (a.progress.value / (a.progress.max || 100)) * 100)) : null;
  const fill = el('i');
  if (pct !== null) fill.style.width = `${pct.toFixed(1)}%`;
  return el(
    'article',
    { class: `card item s-${a.status}`, 'data-id': a.id },
    el(
      'div',
      { class: 'card-head' },
      el('span', { class: `badge s-${a.status}`, title: st.hint }, el('span', { class: 'dot' }), a.statusLabel || st.label),
      since(a.statusSince),
      el('span', { class: 'spacer' }),
      appTag(a),
      proc.length ? el('span', { class: 'proc', text: proc.join(' · ') }) : null,
    ),
    el(
      'h2',
      { class: 'name' },
      canFocus(a) ? el('button', { type: 'button', class: 'name-link', title: 'Go to its window', onclick: (e) => goToWindow(a, e.currentTarget) }, a.name) : a.name,
    ),
    a.host || a.where ? el('div', { class: 'where' }, el('span', { class: 'path', text: [a.host, a.where].filter(Boolean).join(' · ') })) : null,
    el(
      'div',
      { class: 'card-body' },
      a.status === 'waiting' && a.waitingFor
        ? el('div', { class: 'now waiting' }, el('div', { class: 'now-row' }, el('span', { class: 'detail', text: a.waitingFor, title: a.waitingFor })))
        : null,
      pct !== null
        ? el('div', { class: 'progress', title: `${Math.round(pct)}%` }, el('span', { class: 'bar' }, fill), el('span', { text: `${Math.round(pct)}%` }))
        : null,
      a.preview ? el('img', { class: 'preview', src: a.preview, alt: `Output of ${a.name}`, loading: 'lazy' }) : null,
      a.facts?.length ? el('dl', { class: 'facts' }, a.facts.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v, title: v })])) : null,
      a.lastReply ? message(a, 'reply', 'Last reply', a.lastReply) : null,
    ),
    el(
      'div',
      { class: 'actions' },
      canFocus(a) ? btn('Go to window', (e) => goToWindow(a, e.currentTarget), 'btn-primary') : null,
      can('open') && a.url ? el('a', { class: 'btn btn-primary', href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.openLabel || `Open in ${APPS[a.app]}`) : null,
      can('stop') ? btn('Stop', (e) => itemAction(a, 'stop', e.currentTarget), 'btn-stop') : null,
      can('cancel') ? btn('Cancel', (e) => itemAction(a, 'cancel', e.currentTarget), 'btn-stop') : null,
      can('unload') ? btn('Unload', (e) => itemAction(a, 'unload', e.currentTarget), 'btn-stop') : null,
    ),
  );
}

const ITEM_DONE = { stop: 'Stopped', cancel: 'Cancelled', unload: 'Unloaded' };

// Stop, Cancel and Unload ask for a second click, like a to-do's Delete.
async function itemAction(a, action, button) {
  if (!button.classList.contains('btn-danger')) {
    const label = button.textContent;
    button.classList.add('btn-danger');
    button.textContent = `${label}?`;
    setTimeout(() => {
      button.classList.remove('btn-danger');
      button.textContent = label;
    }, 3000);
    return;
  }
  button.disabled = true;
  try {
    if (a.leavesWhenDone) stoppedHere.add(a.id);
    await post(a, action);
    toast(`${ITEM_DONE[action]} ${a.name}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
  refresh();
}

function card(a) {
  if (isItem(a)) return itemCard(a);
  const st = status(a);
  const tags = [];
  if (a.gitBranch) tags.push(el('span', { class: 'tag branch', title: 'Git branch', text: `⎇ ${a.gitBranch}` }));
  if (a.kind && a.kind !== 'interactive') tags.push(el('span', { class: 'tag', text: a.kind }));
  if (a.background) tags.push(el('span', { class: 'tag background', title: `Running in the background (${a.entrypoint}), with no window`, text: 'Background' }));
  else if (a.entrypoint && a.entrypoint !== 'cli') tags.push(el('span', { class: 'tag', text: a.entrypoint }));
  const perm = PERMISSION_MODES[a.permissionMode];
  if (perm) tags.push(el('span', { class: 'tag', title: `Permission mode: ${a.permissionMode}`, text: perm }));
  if (a.version) tags.push(el('span', { text: `v${a.version}` }));

  const heading = displayName(a);
  const subtitle = a.title && a.title.toLowerCase() !== heading.toLowerCase() ? a.title : null;
  const proc = a.app === 'codex' ? [] : [a.name];
  if (a.pid) proc.push(`PID ${a.pid}`);
  if (a.memBytes) proc.push(`${Math.round(a.memBytes / 1048576)} MB`);

  const g = groupDef(a.group);
  return el(
    'article',
    { class: `card s-${a.status}${g ? ` grouped g-${g.color}` : ''}`, 'data-id': a.id },
    el(
      'div',
      { class: 'card-head' },
      el('span', { class: `badge s-${a.status}`, title: st.hint }, el('span', { class: 'dot' }), st.label),
      since(a.statusSince),
      el('span', { class: 'spacer' }),
      groupChip(a, a.cwd),
      appTag(a),
      el('span', { class: 'proc', title: `Session ${a.id}\nStarted ${new Date(a.startedAt).toLocaleString()}`, text: proc.join(' · ') }),
    ),
    el(
      'h2',
      { class: 'name' },
      canFocus(a)
        ? el('button', { type: 'button', class: 'name-link', title: 'Go to this session’s window', onclick: (e) => goToWindow(a, e.currentTarget) }, heading)
        : heading,
    ),
    subtitle ? el('p', { class: 'title', text: subtitle }) : null,
    el('div', { class: 'where' }, el('span', { class: 'path', title: a.cwd, text: shortPath(a.cwd) }), tags),
    // The part that scrolls when every card is the same size.
    el(
      'div',
      { class: 'card-body' },
      activity(a),
      stats(a),
      subagents(a),
      a.prs?.length
        ? el(
            'div',
            { class: 'prs' },
            a.prs.map((pr) => el('a', { href: pr.url, target: '_blank', rel: 'noopener noreferrer', text: `${pr.repo || 'PR'}#${pr.number}` })),
          )
        : null,
    ),
    actions(a),
  );
}

// ---- to-dos --------------------------------------------------------------------

// A to-do has its own card until its session starts, then it's on the
// session's card. Card IDs get this prefix so they can't meet a session's.
const TODO_PREFIX = 'todo:';
let editingTodo = null;

const todoText = (t) => (t.notes ? `${t.title}\n\n${t.notes}` : t.title);

async function copyTodo(t) {
  await copy(todoText(t));
  toast('To-do copied');
}

function editTodo(t) {
  editingTodo = t;
  $('todo-dialog-title').textContent = t ? 'Edit to-do' : 'New to-do';
  $('todo-save').textContent = t ? 'Save' : 'Add to-do';
  $('todo-title').value = t?.title || '';
  $('todo-notes').value = t?.notes || '';
  // Which app it starts in, once Codex is installed too.
  $('todo-app-field').hidden = !snap?.codexInstalled;
  $('todo-app-default').textContent = `As in Settings (${APPS[snap?.newSessionApp] || APPS.claude})`;
  $('todo-app').value = t?.app || '';
  $('todo-dialog').showModal();
  $('todo-title').focus();
}

// A to-do with no folder starts in the one Settings names, where Claude or
// Codex can make a new project.
async function startTodo(t, button) {
  if (button) button.disabled = true;
  try {
    await api(`/api/todos/${t.id}/start`);
    toast(`Starting ${APPS[todoApp(t)]} in ${shortPath(t.cwd || snap?.todoStartsIn || '')}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (button) button.disabled = false;
  }
  refresh();
}

// From the repo menu or the folder picker, as Settings says. With
// `start`, Claude starts there once it's chosen.
async function chooseTodoFolder(t, start, button) {
  if (serverSettings?.todoFolderSource !== 'picker') {
    openRepoPicker(t, start);
    return;
  }
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Choosing…';
  try {
    const r = await api(`/api/todos/${t.id}/folder`, { pick: true });
    if (r.cancelled) return;
    if (start) await startTodo({ ...t, cwd: r.cwd });
    else refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// Asks for a second click, so one stray click can't lose the notes.
async function deleteTodo(t, button) {
  if (!button.classList.contains('btn-danger')) {
    button.classList.add('btn-danger');
    button.textContent = 'Delete?';
    setTimeout(() => {
      button.classList.remove('btn-danger');
      button.textContent = 'Delete';
    }, 3000);
    return;
  }
  button.disabled = true;
  try {
    await api(`/api/todos/${t.id}/delete`);
    refresh();
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
  }
}

function todoCard(t) {
  const btn = (label, onclick, cls = '', props = {}) => el('button', { type: 'button', class: `btn ${cls}`, onclick, ...props }, label);
  const drivable = Boolean(snap?.terminals);
  const startsIn = shortPath(t.cwd || snap?.todoStartsIn || '');
  // Started, but no session with its ID has turned up.
  const stalled = t.startedAt && !t.starting;
  const g = groupDef(t.group);
  return el(
    'article',
    { class: `card todo-card${g ? ` grouped g-${g.color}` : ''}`, 'data-id': TODO_PREFIX + t.id },
    el(
      'div',
      { class: 'card-head' },
      el('span', { class: `badge s-todo${t.starting ? ' starting' : ''}` }, el('span', { class: 'dot' }), t.starting ? 'Starting' : 'To-do'),
      since(t.starting ? t.startedAt : t.createdAt),
      el('span', { class: 'spacer' }),
      groupChip(t, t.cwd || snap?.todoStartsIn),
      // The app it will start, once there's a choice.
      snap?.codexInstalled ? appTag({ app: todoApp(t) }) : null,
    ),
    el('h2', { class: 'name', text: t.title }),
    el(
      'div',
      { class: 'where' },
      t.cwd
        ? el('span', { class: 'path', title: t.cwd, text: shortPath(t.cwd) })
        : el('span', { class: 'no-folder', title: 'No folder chosen: it starts here, where Claude can make a new project', text: `Starts in ${startsIn}` }),
    ),
    el(
      'div',
      { class: 'card-body' },
      el(
        'div',
        { class: 'activity' },
        t.starting
          ? el('div', { class: 'now' }, el('div', { class: 'now-row' }, el('span', { class: 'what', text: `Opening ${APPS[todoApp(t)]}` }), el('span', { class: 'detail', text: 'in a new terminal tab' })))
          : null,
        stalled
          ? el(
              'div',
              { class: 'now waiting' },
              el('div', { class: 'now-row' }, el('span', { class: 'what', text: 'No session yet' }), el('span', { class: 'detail', text: 'Check its terminal tab, or start it again' })),
            )
          : null,
        t.notes ? message({ id: TODO_PREFIX + t.id }, 'notes', 'Notes', { text: t.notes }, 'todo-text') : null,
      ),
    ),
    el(
      'div',
      { class: 'actions' },
      drivable
        ? btn(stalled ? 'Start again' : 'Start', (e) => startTodo(t, e.currentTarget), 'btn-primary', {
            disabled: t.starting,
            title: `Open a terminal tab in ${startsIn} running ${APPS[todoApp(t)]}`,
          })
        : null,
      drivable ? btn(t.cwd ? 'Change folder' : 'Choose folder', (e) => chooseTodoFolder(t, false, e.currentTarget), '', { disabled: t.starting }) : null,
      btn('Copy', () => copyTodo(t), '', { title: 'Copy the title and notes, to paste into Claude' }),
      btn('Edit', () => editTodo(t)),
      btn('Delete', (e) => deleteTodo(t, e.currentTarget), 'btn-stop'),
    ),
  );
}

$('todo-new').addEventListener('click', () => editTodo(null));
$('todo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const save = $('todo-save');
  save.disabled = true;
  try {
    const body = { title: $('todo-title').value, notes: $('todo-notes').value, app: $('todo-app').value || null };
    await api(editingTodo ? `/api/todos/${editingTodo.id}` : '/api/todos', body);
    $('todo-dialog').close();
    refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    save.disabled = false;
  }
});
// Ctrl+Enter saves from the notes, where Enter is a new line.
$('todo-notes').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $('todo-form').requestSubmit();
  }
});
for (const id of ['todo-cancel', 'todo-close']) $(id).addEventListener('click', () => $('todo-dialog').close());

// ---- page ------------------------------------------------------------------

// A group's heading, when the cards are in sections by group.
function sectionHead(s) {
  return el('h2', { class: `section-head${s.color ? ` g-${s.color}` : ' none'}` }, el('span', { class: 'dot' }), s.name, el('b', { text: String(s.count) }));
}

function render() {
  if (!snap) return;
  renderViewFilters();
  // The app and group chosen in the header narrow everything, the status
  // counts included. To-dos start Claude, so they count as Claude's.
  const inView = (x) =>
    (appFilter === 'all' || (x.app || 'claude') === appFilter) && (groupFilter === 'all' || (groupFilter === 'none' ? !x.group : x.group === groupFilter));
  const agents = snap.agents.filter(inView).sort((x, y) => status(x).rank - status(y).rank || x.startedAt - y.startedAt);
  const todos = (snap.todos || []).filter(inView).sort((x, y) => x.createdAt - y.createdAt);
  const counts = { all: agents.length + todos.length, todo: 0, needs: 0, working: 0, idle: 0 };
  for (const a of agents) counts[status(a).group]++;
  counts.todo = counts.needs + counts.idle + todos.length;
  for (const [k, v] of Object.entries(counts)) if ($(`n-${k}`)) $(`n-${k}`).textContent = v;
  for (const k of ['todo', 'needs']) document.querySelector(`[data-filter="${k}"]`).classList.toggle('has', counts.needs > 0);
  // The tab's title counts every session that needs you, whatever's shown.
  const needsYou = snap.agents.filter((a) => a.status === 'waiting').length;
  document.title = needsYou ? `(${needsYou}) Tabherd` : 'Tabherd';
  $('host').textContent = snap.host;

  const groups = FILTER_GROUPS[filter] || [filter];
  // To-do cards come first, under All and Todo.
  let shown = [
    ...(filter === 'all' || filter === 'todo' ? todos.map((t) => [TODO_PREFIX + t.id, t, todoCard]) : []),
    ...agents.filter((a) => filter === 'all' || groups.includes(status(a).group)).map((a) => [a.id, a, card]),
  ];
  // In sections: each group's cards under its heading, in the groups' order,
  // then those in no group.
  if (sectionsOn && snap.groups?.length) {
    const items = shown;
    shown = [];
    for (const id of [...snap.groups.map((g) => g.id), null]) {
      const inGroup = items.filter(([, d]) => (d.group || null) === id);
      if (!inGroup.length) continue;
      const g = groupDef(id);
      shown.push([`section:${id}`, { name: g ? g.name : 'No group', color: g?.color || null, count: inGroup.length }, sectionHead], ...inGroup);
    }
  }
  const seen = new Set();
  shown.forEach(([id, data, make], i) => {
    seen.add(id);
    // A group's name or colour can change without the card changing.
    const key = JSON.stringify(data) + subsOpen.get(id) + JSON.stringify(groupDef(data.group));
    let entry = cards.get(id);
    if (!entry || entry.key !== key) {
      const node = make(data);
      if (entry) {
        // Keep the card where it was scrolled to, so updates don't jump it.
        const scrolled = entry.node.querySelector('.card-body')?.scrollTop;
        entry.node.replaceWith(node);
        const body = node.querySelector('.card-body');
        if (body && scrolled) body.scrollTop = scrolled;
      }
      entry = { key, node };
      cards.set(id, entry);
    }
    if (list.children[i] !== entry.node) list.insertBefore(entry.node, list.children[i] || null);
  });
  for (const [id, entry] of cards) {
    if (!seen.has(id)) {
      entry.node.remove();
      cards.delete(id);
    }
  }
  const nothing = !snap.agents.length && !snap.todos?.length;
  $('empty').hidden = !nothing && shown.length > 0;
  $('empty').querySelector('.empty-title').textContent = nothing ? 'No Claude Code or Codex sessions are running.' : 'No sessions match this filter.';
}

// The app and group filters in the header. Each shows once there's a choice:
// the app filter once a Codex session is running, the group filter once
// there are groups. Kept in this browser.
const VIEW_KEY = 'tabherd:view';
let appFilter = 'all';
let groupFilter = 'all';
try {
  const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
  if (['all', 'claude', 'codex', 'comfy', 'localai'].includes(saved.app)) appFilter = saved.app;
  if (typeof saved.group === 'string') groupFilter = saved.group;
} catch {}

function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ app: appFilter, group: groupFilter }));
  } catch {}
}

function renderViewFilters() {
  const groups = snap?.groups || [];
  if (!['all', 'none'].includes(groupFilter) && !groups.some((g) => g.id === groupFilter)) groupFilter = 'all';
  const app = $('app-filter');
  // Claude, and each other app with something on the dashboard.
  const apps = ['claude', ...Object.keys(APPS).filter((k) => k !== 'claude' && (k === appFilter || snap.agents.some((a) => a.app === k)))];
  app.hidden = appFilter === 'all' && apps.length < 2;
  const appOptions = [['all', 'All apps'], ...apps.map((k) => [k, APPS[k]])];
  if (app.dataset.signature !== JSON.stringify(appOptions)) {
    app.replaceChildren(...appOptions.map(([value, text]) => el('option', { value, text })));
    app.dataset.signature = JSON.stringify(appOptions);
  }
  app.value = appFilter;
  const select = $('group-filter');
  select.hidden = !groups.length && groupFilter === 'all';
  const options = [['all', 'All groups'], ...groups.map((g) => [g.id, g.name]), ['none', 'No group']];
  const signature = JSON.stringify(options);
  if (select.dataset.signature !== signature) {
    select.replaceChildren(...options.map(([value, text]) => el('option', { value, text })));
    select.dataset.signature = signature;
  }
  select.value = groupFilter;
  const g = groupDef(groupFilter);
  select.className = `view-select${g ? ` chosen g-${g.color}` : ''}`;
}

$('app-filter').addEventListener('change', (e) => {
  appFilter = e.currentTarget.value;
  saveView();
  render();
});
$('group-filter').addEventListener('change', (e) => {
  groupFilter = e.currentTarget.value;
  saveView();
  render();
});

// ---- updates and dings ---------------------------------------------------------

const SOUND_KEY = 'tabherd:sound';
const DING_GAP_MS = 2000;
let soundOn = true;
try {
  soundOn = localStorage.getItem(SOUND_KEY) !== 'off';
} catch {}
let audio = null;
let lastDingAt = 0;
// The agents in the last update, to see what changed.
let lastAgents = null;
// Background runs stopped from here, which haven't finished on their own.
const stoppedHere = new Set();

function audioContext() {
  if (!audio) {
    try {
      audio = new AudioContext();
      audio.addEventListener('statechange', updateSoundButton);
    } catch {
      return null;
    }
  }
  return audio;
}

function tone(ctx, freq, start, length, peak) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + length + 0.05);
}

const SOUNDS = {
  // Two rising notes: your turn.
  needs: (ctx, t) => {
    tone(ctx, 784, t, 0.35, 0.22);
    tone(ctx, 1175, t + 0.16, 0.55, 0.22);
  },
  // One soft bell: something finished.
  done: (ctx, t) => {
    tone(ctx, 1047, t, 0.9, 0.16);
    tone(ctx, 2890, t, 0.25, 0.025);
  },
};

function ding(kind) {
  const ctx = audioContext();
  if (!soundOn || !ctx || ctx.state !== 'running') return;
  SOUNDS[kind](ctx, ctx.currentTime + 0.02);
}

function updateSoundButton() {
  const blocked = soundOn && audio?.state !== 'running';
  const button = $('sound');
  button.classList.toggle('off', !soundOn);
  button.classList.toggle('blocked', blocked);
  button.setAttribute('aria-pressed', String(soundOn));
  $('sound-label').textContent = blocked ? 'Click to enable sound' : '';
  button.title = !soundOn
    ? 'Sound is off. Click to ding when an agent needs you or finishes.'
    : blocked
      ? 'The browser blocks sound until you click the page'
      : 'Dings when an agent needs you or finishes. Click to mute.';
}

// Browsers only let a page play sound after it has been clicked or typed in.
function unlockAudio() {
  const ctx = audioContext();
  if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
}

// Waiting on you, or done with a turn: Working to Idle, or to waiting at the
// prompt beside a background shell.
function notableChanges(agents) {
  const needs = [];
  const done = [];
  if (lastAgents) {
    for (const a of agents) {
      const before = lastAgents.get(a.id)?.status;
      if (before === undefined || before === a.status) continue;
      if (a.status === 'waiting') needs.push(a);
      else if (before === 'busy' && (a.status === 'idle' || a.status === 'shell')) done.push(a);
    }
    // A background run doesn't wait at a prompt when it's done: it exits.
    const running = new Set(agents.map((a) => a.id));
    for (const [id, a] of lastAgents) {
      // So do downloads, and anything else that leaves once it's done.
      if ((a.background || a.leavesWhenDone) && !running.has(id) && !stoppedHere.delete(id)) done.push(a);
    }
  }
  lastAgents = new Map(agents.map((a) => [a.id, a]));
  return { needs, done };
}

function announce({ needs, done }) {
  if (!needs.length && !done.length) return;
  for (const a of [...needs, ...done]) {
    const node = cards.get(a.id)?.node;
    if (!node) continue;
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }
  const names = (list) => (list.length === 1 ? displayName(list[0]) : `${list.length} agents`);
  if (needs.length) toast(`${names(needs)} ${needs.length === 1 ? 'needs' : 'need'} you${needs.length === 1 && needs[0].waitingFor ? `: ${needs[0].waitingFor}` : ''}`);
  else toast(`${names(done)} finished`);
  if (Date.now() - lastDingAt < DING_GAP_MS) return;
  lastDingAt = Date.now();
  ding(needs.length ? 'needs' : 'done');
}

// ---- notification list --------------------------------------------------------

// Each "needs you" or "finished" also goes in a list, so it can still be seen
// after its toast fades. The setting under Notifications keeps it in this
// browser across reloads.
const NOTES_KEY = 'tabherd:notifications';
const KEEP_NOTES_KEY = 'tabherd:keep-notifications';
let keepNotes = true;
let notes = [];
let notesKey = null;
try {
  keepNotes = localStorage.getItem(KEEP_NOTES_KEY) !== 'off';
  const saved = keepNotes && JSON.parse(localStorage.getItem(NOTES_KEY) || '[]');
  if (Array.isArray(saved)) notes = saved;
} catch {}

function saveNotes() {
  try {
    if (keepNotes) localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
    else localStorage.removeItem(NOTES_KEY);
  } catch {}
}

// An agent that's working again has been dealt with, and so has a question
// it's no longer waiting on. Each agent keeps only its latest entry.
function updateNotes(agents, { needs, done }) {
  const live = new Map(agents.map((a) => [a.id, a]));
  const before = notes.length;
  notes = notes.filter((n) => {
    const a = live.get(n.id);
    return !a || (a.status !== 'busy' && (n.kind !== 'needs' || a.status === 'waiting'));
  });
  const added = [
    ...needs.map((a) => ({ id: a.id, kind: 'needs', name: displayName(a), detail: a.waitingFor || '', at: snap.now })),
    ...done.map((a) => ({ id: a.id, kind: 'done', name: displayName(a), detail: '', background: Boolean(a.background), at: snap.now })),
  ];
  if (added.length) notes = [...added, ...notes.filter((n) => !added.some((x) => x.id === n.id))];
  if (added.length || notes.length !== before) saveNotes();
  renderNotes();
}

function clearNotes(note) {
  notes = note ? notes.filter((n) => n !== note) : [];
  saveNotes();
  renderNotes();
}

function renderNotes() {
  const live = new Map((snap?.agents || []).map((a) => [a.id, a]));
  const rows = notes.map((n) => {
    const a = live.get(n.id);
    return { n, a, name: a ? displayName(a) : n.name, focus: Boolean(a && canFocus(a)) };
  });
  // A finished background run is picked up again from the history.
  const resumable = (n) => n.background && Boolean(snap?.terminals);
  // Rebuilt only when something shown changes, so an open list doesn't flicker.
  const key = JSON.stringify(rows.map((r) => [r.n.id, r.n.kind, r.n.at, r.name, Boolean(r.a), r.focus, resumable(r.n)]));
  if (key === notesKey) return;
  notesKey = key;
  $('notes-list').replaceChildren(
    ...rows.map(({ n, a, name, focus }) => {
      const what = [n.kind === 'needs' ? `Needs you${n.detail ? `: ${n.detail}` : ''}` : n.background ? 'Finished in the background' : 'Finished'];
      if (!a && !n.background) what.push('session closed');
      return el(
        'li',
        { class: `note k-${n.kind}` },
        el('span', { class: 'dot' }),
        el(
          'span',
          { class: 'note-text' },
          focus
            ? el('button', { type: 'button', class: 'name-link note-name', title: 'Go to this session’s window', onclick: (e) => goToWindow(a, e.currentTarget) }, name)
            : !a && resumable(n)
              ? el('button', { type: 'button', class: 'name-link note-name', title: 'Open a terminal tab in its folder and continue the conversation', onclick: (e) => resumeNote(n, e.currentTarget) }, name)
              : el('span', { class: 'note-name', text: name }),
          el('span', { class: 'note-what', text: what.join(' · '), title: what.join(' · ') }),
        ),
        since(n.at, ' ago'),
        el('button', { type: 'button', class: 'icon-btn note-clear', title: 'Clear', 'aria-label': `Clear ${name}`, onclick: () => clearNotes(n) }, '✕'),
      );
    }),
  );
  $('notes-empty').hidden = notes.length > 0;
  $('notes-clear').hidden = !notes.length;
  $('n-notes').textContent = notes.length || '';
  const needCount = notes.filter((n) => n.kind === 'needs').length;
  $('notes-button').classList.toggle('has-needs', needCount > 0);
  $('notes-button').title = notes.length
    ? `${notes.length} notification${notes.length === 1 ? '' : 's'}${needCount ? `, ${needCount} needing you` : ''}`
    : 'Notifications';
}

$('notes-clear').addEventListener('click', () => clearNotes());

// Resumes a finished background run from its notification, as History does.
async function resumeNote(n, button) {
  button.disabled = true;
  try {
    await api(`/api/history/${n.id}/resume`);
    toast(`Resuming ${n.name}`);
    clearNotes(n);
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

function apply(next) {
  snap = next;
  clockSkew = snap.now - Date.now();
  $('conn').className = 'conn live';
  $('updated').textContent = `Live · ${new Date(snap.now).toLocaleTimeString()}`;
  list.classList.remove('stale');
  const changes = notableChanges(snap.agents);
  render();
  announce(changes);
  updateNotes(snap.agents, changes);
}

function disconnected() {
  $('conn').className = 'conn down';
  $('updated').textContent = 'Disconnected. Is the server running?';
  list.classList.add('stale');
}

// A one-off update, so an action's effect shows without waiting for a push.
async function refresh() {
  try {
    const res = await fetch('/api/agents', { cache: 'no-store' });
    if (res.ok) apply(await res.json());
  } catch {}
}

function connect() {
  const source = new EventSource('/api/stream');
  source.onmessage = (e) => apply(JSON.parse(e.data));
  // EventSource reconnects by itself.
  source.onerror = disconnected;
}

function confirmStop(a) {
  const dialog = $('confirm');
  $('confirm-name').textContent = displayName(a);
  // Codex runs the session in its background service: Stop interrupts its
  // turn there, then ends the Codex in its window, if that's known.
  $('confirm-what').textContent =
    a.app === 'codex'
      ? `This interrupts its current turn${a.pid ? ` and ends Codex in its window, PID ${a.pid}` : ''}. What the turn hasn't finished is lost.${a.pid ? '' : " Its window isn't known, so close that yourself."}`
      : `This force-ends PID ${a.pid} along with its shells and MCP servers. Anything the current turn hasn't saved is lost.`;
  $('confirm-resume').textContent = resumeCommand(a);
  dialog.returnValue = '';
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'stop') return;
    try {
      if (a.background) stoppedHere.add(a.id);
      const r = await post(a, 'stop');
      toast(r.windowLeft ? `Interrupted ${displayName(a)}. Close its window to end it.` : `Stopped ${displayName(a)}`);
    } catch (err) {
      toast(err.message, true);
    }
    refresh();
  };
  dialog.showModal();
}

// ---- repo menu ---------------------------------------------------------------

const OPEN_FOLDERS_KEY = 'tabherd:open-folders';
let repoData = null;
let openFolders = new Set();
try {
  openFolders = new Set(JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY) || '[]'));
} catch {}

function saveOpenFolders() {
  try {
    localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...openFolders]));
  } catch {}
}

function filterTerms() {
  return $('repos-filter').value.toLowerCase().split(/\s+/).filter(Boolean);
}

// How many running sessions have their folder in this repo.
function sessionsIn(repoPath) {
  const dir = `${repoData.root}\\${repoPath.replace(/\//g, '\\')}`.toLowerCase();
  return (snap?.agents || []).filter((a) => {
    const cwd = (a.cwd || '').toLowerCase();
    return cwd === dir || cwd.startsWith(`${dir}\\`);
  }).length;
}

// Every word must be in the repo's path and at least one in its own name, so
// "acme" finds the acme repos rather than everything under the Acme folder,
// while "api auth" still finds Api-Repos/_wt/auth.
function repoMatches(node, terms) {
  const p = node.path.toLowerCase();
  const name = node.name.toLowerCase();
  return terms.every((t) => p.includes(t)) && terms.some((t) => name.includes(t));
}

// A dot in the colour of the group that has this folder or repo among its
// folders, if one does.
function folderGroupDot(node) {
  if (!repoData) return null;
  const sep = repoSep();
  const full = `${repoData.root}${sep}${node.path.split('/').join(sep)}`.toLowerCase();
  const g = (snap?.groups || []).find((x) => x.folders.some((f) => f.toLowerCase() === full));
  return g ? el('span', { class: `group-dot g-${g.color}`, title: `Group: ${g.name}` }) : null;
}

function repoItem(node, terms) {
  if (terms.length && !repoMatches(node, terms)) return null;
  const live = sessionsIn(node.path);
  return el(
    'li',
    {},
    el(
      'button',
      {
        type: 'button',
        class: 'repo',
        'data-path': node.path,
        title: repoPick ? `Use ${node.path}` : `Open ${APPS[repoData.app] || APPS.claude} in ${node.path}`,
        onclick: (e) => (repoPick ? pickRepo(node, e.currentTarget) : openRepo(node, e.currentTarget)),
      },
      el('span', { class: 'repo-name', text: node.name }),
      folderGroupDot(node),
      live
        ? el('span', { class: 'repo-live', title: `${live} session${live === 1 ? '' : 's'} running here` }, el('span', { class: 'dot' }), String(live))
        : null,
    ),
  );
}

function folderItem(node, terms) {
  const list = treeList(node.children, terms);
  if (!list) return null;
  return el(
    'li',
    {},
    el(
      'details',
      {
        'data-path': node.path,
        // While filtering, every folder with a match is open.
        open: terms.length > 0 || openFolders.has(node.path),
        ontoggle: (e) => {
          if (filterTerms().length) return;
          if (e.currentTarget.open) openFolders.add(node.path);
          else openFolders.delete(node.path);
          saveOpenFolders();
        },
      },
      el(
        'summary',
        {},
        el('span', { class: 'chev' }),
        el('span', { class: 'folder-name', text: node.name }),
        folderGroupDot(node),
        el('span', { class: 'folder-count', text: String(list.querySelectorAll('.repo').length) }),
      ),
      list,
    ),
  );
}

function treeList(nodes, terms) {
  const items = nodes.map((n) => (n.repo ? repoItem(n, terms) : folderItem(n, terms))).filter(Boolean);
  return items.length ? el('ul', {}, items) : null;
}

function renderRepos() {
  if (!repoData) return;
  const terms = filterTerms();
  const list = treeList(repoData.tree, terms);
  $('repos-tree').replaceChildren(list || el('p', { class: 'tree-empty', text: terms.length ? 'No repos match.' : 'No git repos found.' }));
}

async function loadRepos(refresh) {
  try {
    const res = await fetch(`/api/repos${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Couldn't list repos (HTTP ${res.status})`);
    repoData = await res.json();
    const excluded = repoData.excluded ? ` · ${repoData.excluded} hidden` : '';
    $('repos-root').textContent = `${shortPath(repoData.root)} · ${repoData.count} repos${excluded}`;
    $('repos-root').title = excluded ? 'Change what is hidden in Settings' : '';
    $('repos-command').textContent = repoData.command;
    // Claude or Codex, once Codex is installed; it's the setting in Settings.
    $('repos-app').hidden = !snap?.codexInstalled;
    for (const r of document.querySelectorAll('input[name="repos-app"]')) r.checked = r.value === repoData.app;
    renderRepos();
    renderExcluded();
    renderServerSettings();
    renderFolderSuggestions();
  } catch (err) {
    toast(err.message, true);
  }
}

async function openRepo(node, button) {
  button.disabled = true;
  try {
    await api('/api/repos/open', { path: node.path });
    $('repos').close();
    toast(`Opening ${APPS[repoData.app] || APPS.claude} in ${node.name}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

// The menu also chooses a to-do's folder. While it does, clicking a repo
// picks it rather than opening Claude there.
let repoPick = null;

function openRepoPicker(todo, start) {
  repoPick = { todo, start };
  $('repos-title').textContent = 'Choose a folder';
  $('repos-foot').hidden = true;
  $('repos-pick-foot').hidden = false;
  $('repos-pick-foot').textContent = start ? `Click a repo to start “${todo.title}” there.` : `Click a repo to use it for “${todo.title}”.`;
  $('repos-filter').value = '';
  $('repos').showModal();
  $('repos-filter').focus();
  renderRepos();
  loadRepos(false).then(showStartFolder);
}

// Opens the folder Settings says to start in, and scrolls to it.
function showStartFolder() {
  const start = serverSettings?.todoStartFolder;
  if (!repoPick || !start || !repoData) return;
  const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  const root = norm(repoData.root);
  if (!norm(start).startsWith(`${root}/`)) return;
  const rel = norm(start).slice(root.length + 1);
  const node = repoNodes(repoData.tree).find((n) => n.path.toLowerCase() === rel);
  if (!node) return;
  const parts = node.path.split('/');
  for (let i = 1; i <= parts.length; i++) openFolders.add(parts.slice(0, i).join('/'));
  saveOpenFolders();
  renderRepos();
  $('repos-tree').querySelector(`[data-path="${CSS.escape(node.path)}"]`)?.scrollIntoView({ block: 'start' });
}

async function pickRepo(node, button) {
  const { todo, start } = repoPick;
  button.disabled = true;
  try {
    const r = await api(`/api/todos/${todo.id}/folder`, { repo: node.path });
    $('repos').close();
    if (start) await startTodo({ ...todo, cwd: r.cwd });
    else refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

$('repos').addEventListener('close', () => {
  if (!repoPick) return;
  repoPick = null;
  $('repos-title').textContent = 'Repositories';
  $('repos-foot').hidden = false;
  $('repos-pick-foot').hidden = true;
});

$('menu-button').addEventListener('click', () => {
  $('repos').showModal();
  $('repos-filter').focus();
  loadRepos(false);
});
$('repos-close').addEventListener('click', () => $('repos').close());
$('repos-refresh').addEventListener('click', () => loadRepos(true));
$('repos-filter').addEventListener('input', renderRepos);
$('repos-filter').addEventListener('keydown', (e) => {
  // Enter opens the repo when the filter leaves exactly one.
  const matches = $('repos-tree').querySelectorAll('.repo');
  if (e.key === 'Enter' && filterTerms().length && matches.length === 1) matches[0].click();
});
// A click on the backdrop lands on the dialog itself.
$('repos').addEventListener('click', (e) => e.target === e.currentTarget && e.currentTarget.close());
// #repos opens the menu; #repos/<filter> also fills in the filter.
const repoLink = location.hash.match(/^#repos(?:\/(.*))?$/);
if (repoLink) {
  $('repos-filter').value = decodeURIComponent(repoLink[1] || '');
  $('menu-button').click();
}

// ---- history -------------------------------------------------------------------

// Closed sessions, newest first, as the server recorded them or read them back
// from their transcripts.
let historyData = null;

// A session read back from its transcript has no terminal title or session
// name, so it falls back to its title or first prompt.
const pastName = (s) => s.terminalTitle || s.title || s.firstPrompt?.text || s.name || shortPath(s.cwd);

function dayLabel(t) {
  const d = new Date(t);
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(new Date(now())) - midnight(d)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

async function resumePast(s, button) {
  button.disabled = true;
  try {
    await api(`/api/history/${s.id}/resume`);
    $('history').close();
    toast(`Resuming ${pastName(s)}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

function pastItem(s) {
  const name = pastName(s);
  const subtitle = s.title && s.title !== name ? s.title : null;
  const meta = [];
  if (s.prompts) meta.push(`${s.prompts} prompt${s.prompts === 1 ? '' : 's'}`);
  if (s.model) meta.push(modelLabel(s));
  return el(
    'li',
    { class: 'past' },
    el('div', { class: 'past-head' }, el('span', { class: 'past-name', text: name, title: name }), groupTag(s), appTag(s), since(s.closedAt, ' ago')),
    subtitle ? el('p', { class: 'past-title', text: subtitle, title: subtitle }) : null,
    s.todo ? el('p', { class: 'past-title', title: todoText(s.todo) }, el('b', {}, 'To-do · '), s.todo.title) : null,
    el(
      'div',
      { class: 'where' },
      el('span', { class: 'path', text: shortPath(s.cwd), title: s.cwd }),
      s.gitBranch ? el('span', { class: 'tag branch', title: 'Git branch', text: `⎇ ${s.gitBranch}` }) : null,
      s.background ? el('span', { class: 'tag background', title: 'Ran in the background, with claude -p', text: 'Background' }) : null,
    ),
    s.lastPrompt ? el('p', { class: 'past-prompt', title: s.lastPrompt.text }, el('b', {}, 'Last prompt · '), s.lastPrompt.text) : null,
    el(
      'div',
      { class: 'past-actions' },
      snap?.terminals
        ? el('button', { type: 'button', class: 'btn btn-primary', title: 'Open a terminal tab in its folder and continue the conversation', onclick: (e) => resumePast(s, e.currentTarget) }, 'Resume')
        : null,
      el(
        'button',
        {
          type: 'button',
          class: 'btn',
          onclick: async () => {
            await copy(resumeCommand(s));
            toast('Resume command copied');
          },
        },
        'Copy resume command',
      ),
      meta.length ? el('span', { class: 'past-meta', text: meta.join(' · ') }) : null,
    ),
  );
}

// Every word must appear somewhere in the session's names, folder, branch or prompts.
function renderHistory() {
  if (!historyData) return;
  const terms = $('history-filter').value.toLowerCase().split(/\s+/).filter(Boolean);
  const background = $('history-background').checked;
  const shown = historyData.filter((s) => {
    if (s.background && !background) return false;
    const text = [pastName(s), s.title, s.name, s.cwd, s.gitBranch, s.firstPrompt?.text, s.lastPrompt?.text, s.todo?.title, s.todo?.notes]
      .join(' ')
      .toLowerCase();
    return terms.every((t) => text.includes(t));
  });
  const n = historyData.length;
  $('history-sub').textContent = `${n} closed session${n === 1 ? '' : 's'}${shown.length < n ? ` · ${shown.length} shown` : ''}`;
  // The switch for background runs only shows once there are some.
  $('history-background-label').hidden = !historyData.some((s) => s.background);
  const days = [];
  for (const s of shown) {
    const day = dayLabel(s.closedAt);
    if (days.at(-1)?.day !== day) days.push({ day, sessions: [] });
    days.at(-1).sessions.push(s);
  }
  $('history-list').replaceChildren(
    ...(days.length
      ? days.flatMap((d) => [el('h3', { class: 'history-day', text: d.day }), el('ul', {}, d.sessions.map(pastItem))])
      : [el('p', { class: 'tree-empty', text: n ? 'No closed sessions match.' : 'No sessions have closed in the last 30 days.' })]),
  );
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history', { cache: 'no-store' });
    if (!res.ok) throw new Error(`Couldn't load the history (HTTP ${res.status})`);
    historyData = (await res.json()).sessions;
    renderHistory();
  } catch (err) {
    $('history-sub').textContent = err.message;
  }
}

$('history-button').addEventListener('click', () => {
  $('history').showModal();
  $('history-filter').focus();
  loadHistory();
});
$('history-close').addEventListener('click', () => $('history').close());
$('history-filter').addEventListener('input', renderHistory);
// Whether History lists background runs, such as `claude -p` reviews. Kept in this browser.
const HISTORY_BACKGROUND_KEY = 'tabherd:history-background';
try {
  $('history-background').checked = localStorage.getItem(HISTORY_BACKGROUND_KEY) !== 'off';
} catch {}
$('history-background').addEventListener('change', (e) => {
  try {
    localStorage.setItem(HISTORY_BACKGROUND_KEY, e.currentTarget.checked ? 'on' : 'off');
  } catch {}
  renderHistory();
});
$('history').addEventListener('click', (e) => e.target === e.currentTarget && e.currentTarget.close());

// ---- settings ----------------------------------------------------------------

// A group of radio buttons saved in this browser as tabherd:<name>. The
// first value is the default. `apply` runs now and on every change.
function radioSetting(name, values, apply) {
  const key = `tabherd:${name}`;
  const radios = document.querySelectorAll(`input[name="${name}"]`);
  let value = values[0];
  try {
    const saved = localStorage.getItem(key);
    if (values.includes(saved)) value = saved;
  } catch {}
  const update = () => {
    for (const r of radios) r.checked = r.value === value;
    apply(value);
  };
  for (const r of radios) {
    r.addEventListener('change', () => {
      value = r.value;
      try {
        localStorage.setItem(key, value);
      } catch {}
      update();
    });
  }
  update();
}

// System follows the system's light or dark mode; Light and Dark override it.
radioSetting('theme', ['system', 'light', 'dark'], (theme) => {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
});

// Fit lets each card grow to its content; the others make every card the same size.
radioSetting('card-size', ['fit', 'small', 'medium', 'large'], (size) => {
  list.dataset.size = size;
  list.classList.toggle('uniform', size !== 'fit');
});

// Folders and repos left out of the repo menu. The server keeps these, for
// every browser, as paths under the repos folder with forward slashes.
let serverSettings = null;
// The terminals this computer offers for new sessions: [{ id, name, available }].
let terminalChoices = [];

const repoSep = () => (repoData?.root.includes('\\') ? '\\' : '/');
const showRepoPath = (p) => p.replace(/\//g, repoSep());

// Every folder and repo in a tree.
function repoNodes(nodes, out = []) {
  for (const n of nodes) {
    out.push(n);
    if (n.children) repoNodes(n.children, out);
  }
  return out;
}

// Folders opened in this tree. Until the first render, every folder above a
// hidden one opens, so what's hidden is in view.
let excludedOpen = null;

const excludedSet = () => new Set((serverSettings?.excludedFolders || []).map((p) => p.toLowerCase()));
const excludedFilter = () => $('excluded-filter').value.toLowerCase().split(/\s+/).filter(Boolean);

// How many repos are in this folder, and how many of them are hidden.
function repoTally(node, excluded, hidden = false) {
  hidden ||= excluded.has(node.path.toLowerCase());
  if (node.repo) return { total: 1, hidden: hidden ? 1 : 0 };
  const tally = { total: 0, hidden: 0 };
  for (const c of node.children) {
    const t = repoTally(c, excluded, hidden);
    tally.total += t.total;
    tally.hidden += t.hidden;
  }
  return tally;
}

function setExcluded(node, show) {
  const list = (serverSettings?.excludedFolders || []).filter((p) => p.toLowerCase() !== node.path.toLowerCase());
  saveExcluded(show ? list : [...list, node.path]);
}

// A tick box for one folder or repo. Inside a hidden folder it's unticked and
// disabled, though the folder or repo keeps its own setting for when the
// folder is shown again.
function excludedBox(node, excluded, hiddenBy) {
  const label = showRepoPath(node.path);
  return el('input', {
    type: 'checkbox',
    'data-path': node.path,
    checked: !hiddenBy && !excluded.has(node.path.toLowerCase()),
    disabled: !!hiddenBy,
    title: hiddenBy ? `Hidden along with ${showRepoPath(hiddenBy)}` : null,
    'aria-label': `Show ${label} in the repo menu`,
    onchange: (e) => setExcluded(node, e.currentTarget.checked),
  });
}

// Filtering works like the menu's. A folder that matches by itself lists
// everything inside it.
function excludedItem(node, terms, excluded, hiddenBy) {
  const matches = terms.length > 0 && repoMatches(node, terms);
  if (node.repo) {
    if (terms.length && !matches) return null;
    return el(
      'li',
      {},
      el('label', { class: 'excluded-repo' }, excludedBox(node, excluded, hiddenBy), el('span', { class: 'repo-name', text: node.name })),
    );
  }
  const off = hiddenBy || (excluded.has(node.path.toLowerCase()) ? node.path : null);
  const list = excludedList(node.children, matches ? [] : terms, excluded, off);
  if (!list) return null;
  const { total, hidden } = repoTally(node, excluded);
  const count = !hidden ? String(total) : hidden === total ? `${total} hidden` : `${hidden} of ${total} hidden`;
  // The filter opens folders with matches inside; those aren't remembered.
  const auto = terms.length > 0 && !matches;
  return el(
    'li',
    {},
    el(
      'details',
      {
        open: auto || excludedOpen.has(node.path),
        ontoggle: (e) => {
          if (auto) return;
          if (e.currentTarget.open) excludedOpen.add(node.path);
          else excludedOpen.delete(node.path);
        },
      },
      el(
        'summary',
        {},
        el('span', { class: 'chev' }),
        excludedBox(node, excluded, hiddenBy),
        el('span', { class: 'folder-name', text: node.name }),
        el('span', { class: `folder-count${hidden && hidden < total ? ' some' : ''}`, text: count }),
      ),
      list,
    ),
  );
}

function excludedList(nodes, terms, excluded, hiddenBy) {
  const items = nodes.map((n) => excludedItem(n, terms, excluded, hiddenBy)).filter(Boolean);
  return items.length ? el('ul', {}, items) : null;
}

function renderExcluded() {
  const tree = $('excluded-tree');
  if (!repoData?.all || !serverSettings) {
    tree.replaceChildren(el('p', { class: 'tree-empty', text: 'Loading…' }));
    return;
  }
  const excluded = excludedSet();
  if (!excludedOpen) {
    // Hidden paths match in any case; the tree needs each folder's path as found.
    const byLower = new Map(repoNodes(repoData.all).map((n) => [n.path.toLowerCase(), n.path]));
    excludedOpen = new Set();
    for (const p of excluded) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) {
        const found = byLower.get(parts.slice(0, i).join('/'));
        if (found) excludedOpen.add(found);
      }
    }
  }
  // Rebuilding the tree would lose focus from the box just clicked.
  const focused = tree.contains(document.activeElement) ? document.activeElement.dataset.path : null;
  const terms = excludedFilter();
  tree.replaceChildren(
    excludedList(repoData.all, terms, excluded, null) ||
      el('p', { class: 'tree-empty', text: terms.length ? 'No folders or repos match.' : 'No git repos found.' }),
  );
  if (focused) tree.querySelector(`input[data-path="${CSS.escape(focused)}"]`)?.focus();

  // Hidden paths that the scan no longer finds can still be removed.
  const found = new Set(repoNodes(repoData.all).map((n) => n.path.toLowerCase()));
  const missing = (serverSettings.excludedFolders || []).filter((p) => !found.has(p.toLowerCase()));
  $('excluded-missing').hidden = !missing.length;
  $('excluded-list').replaceChildren(
    ...missing.map((p) =>
      el(
        'li',
        {},
        el('span', { class: 'excluded-path', text: showRepoPath(p), title: showRepoPath(p) }),
        el(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            title: 'Stop hiding it',
            'aria-label': `Stop hiding ${showRepoPath(p)}`,
            onclick: () => setExcluded({ path: p }, true),
          },
          '✕',
        ),
      ),
    ),
  );
}

async function loadServerSettings() {
  try {
    const res = await fetch('/api/settings', { cache: 'no-store' });
    if (!res.ok) throw new Error(`Couldn't load settings (HTTP ${res.status})`);
    const data = await res.json();
    serverSettings = data.settings;
    terminalChoices = data.terminals || [];
    renderExcluded();
    renderServerSettings();
  } catch (err) {
    toast(err.message, true);
  }
}

// Shown only where there's a choice to make. A terminal that isn't found here
// stays listed, so a choice made before it was removed still shows.
function renderTerminalChoice() {
  const select = $('terminal-choice');
  $('terminal-setting').hidden = terminalChoices.length < 2;
  const current = serverSettings?.terminal || 'auto';
  select.replaceChildren(
    el('option', { value: 'auto', text: 'Automatic' }),
    ...terminalChoices.map((t) =>
      el('option', { value: t.id, text: t.available ? t.name : `${t.name} (not found)`, disabled: !t.available && t.id !== current }),
    ),
  );
  select.value = current;
}

// The settings kept on the server, other than the repo menu's. The to-do
// folder box isn't changed under someone typing in it.
function renderServerSettings() {
  const url = $('localai-url');
  if (document.activeElement !== url) url.value = serverSettings?.localaiUrl || '';
  const key = $('localai-key');
  key.placeholder = serverSettings?.localaiKeySet ? 'Set. Type a new one to change it' : 'None';
  $('app-setting').hidden = !snap?.codexInstalled;
  const app = serverSettings?.newSessionApp || 'claude';
  for (const r of document.querySelectorAll('input[name="new-app"]')) r.checked = r.value === app;
  $('skip-permissions').checked = Boolean(serverSettings?.skipPermissions);
  const source = serverSettings?.todoFolderSource || 'repos';
  for (const r of document.querySelectorAll('input[name="todo-source"]')) r.checked = r.value === source;
  const input = $('todo-start');
  if (repoData) input.placeholder = shortPath(repoData.root);
  if (document.activeElement !== input) input.value = shortPath(serverSettings?.todoStartFolder || '');
  renderTerminalChoice();
}

async function saveServerSetting(changes) {
  try {
    serverSettings = (await api('/api/settings', changes)).settings;
    if ('todoStartFolder' in changes) $('todo-start').value = shortPath(serverSettings.todoStartFolder);
    renderServerSettings();
    return true;
  } catch (err) {
    toast(err.message, true);
    renderServerSettings();
    return false;
  }
}

$('skip-permissions').addEventListener('change', (e) => saveServerSetting({ skipPermissions: e.currentTarget.checked }));
$('localai-url').addEventListener('change', (e) => saveServerSetting({ localaiUrl: e.currentTarget.value }));
$('localai-url').addEventListener('keydown', noSubmit((input) => input.blur()));
// The key box is left empty; what's typed replaces the key, and it's cleared
// once saved, so the key is never shown.
$('localai-key').addEventListener('change', async (e) => {
  const input = e.currentTarget;
  if (await saveServerSetting({ localaiKey: input.value })) input.value = '';
});
$('localai-key').addEventListener('keydown', noSubmit((input) => input.blur()));
for (const r of document.querySelectorAll('input[name="new-app"]')) {
  r.addEventListener('change', () => saveServerSetting({ newSessionApp: r.value }).then(() => refresh()));
}
// The repo menu's own Claude or Codex choice is the same setting.
for (const r of document.querySelectorAll('input[name="repos-app"]')) {
  r.addEventListener('change', async () => {
    if (await saveServerSetting({ newSessionApp: r.value })) await loadRepos(false);
    refresh();
  });
}
$('terminal-choice').addEventListener('change', (e) => saveServerSetting({ terminal: e.currentTarget.value }));
for (const r of document.querySelectorAll('input[name="todo-source"]')) {
  r.addEventListener('change', () => saveServerSetting({ todoFolderSource: r.value }));
}
$('todo-start').addEventListener('change', (e) => saveServerSetting({ todoStartFolder: e.currentTarget.value }));
$('todo-start').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  // Enter would otherwise submit the dialog's form, which closes it.
  e.preventDefault();
  saveServerSetting({ todoStartFolder: e.currentTarget.value });
});

// The tree changes at once and the saves go out one at a time, in order. Only
// the latest save's reply is shown, so quick clicks don't flicker back.
let excludedSaving = Promise.resolve();
let excludedSaves = 0;

function saveExcluded(list) {
  const n = ++excludedSaves;
  serverSettings = { ...serverSettings, excludedFolders: list };
  renderExcluded();
  excludedSaving = excludedSaving.then(async () => {
    try {
      const saved = (await api('/api/settings', { excludedFolders: list })).settings;
      if (n === excludedSaves) serverSettings = saved;
    } catch (err) {
      toast(err.message, true);
      if (n === excludedSaves) await loadServerSettings();
    }
    if (n === excludedSaves) await loadRepos(false);
  });
}

$('excluded-filter').addEventListener('input', renderExcluded);
$('excluded-filter').addEventListener('keydown', (e) => {
  // Enter would otherwise submit the dialog's form, which closes it.
  if (e.key === 'Enter') e.preventDefault();
});

// ---- group settings ------------------------------------------------------------

// Sections by group is kept in this browser, like the card size.
const SECTIONS_KEY = 'tabherd:group-sections';
let sectionsOn = false;
try {
  sectionsOn = localStorage.getItem(SECTIONS_KEY) === 'on';
} catch {}
$('group-sections').checked = sectionsOn;
$('group-sections').addEventListener('change', (e) => {
  sectionsOn = e.currentTarget.checked;
  try {
    localStorage.setItem(SECTIONS_KEY, sectionsOn ? 'on' : 'off');
  } catch {}
  render();
});

// The groups as edited here. Every change saves the whole list, one save at a
// time, in order; only the latest save's reply is shown.
let groupsDraft = null;
let groupsSaving = Promise.resolve();
let groupSaves = 0;

const editedGroups = () => groupsDraft || snap?.groups || [];

function saveGroups(next, focusKey) {
  const n = ++groupSaves;
  groupsDraft = next;
  renderGroupEditor(focusKey);
  groupsSaving = groupsSaving.then(async () => {
    try {
      const saved = (await api('/api/groups', { groups: next })).groups;
      if (n === groupSaves) {
        groupsDraft = saved;
        if (snap) snap = { ...snap, groups: saved };
      }
    } catch (err) {
      toast(err.message, true);
      if (n === groupSaves) groupsDraft = null;
    }
    if (n === groupSaves) {
      renderGroupEditor();
      refresh();
    }
  });
}

const changeGroup = (g, changes, focusKey) => saveGroups(editedGroups().map((x) => (x.id === g.id ? { ...x, ...changes } : x)), focusKey);

function addGroupFolder(g, input) {
  const folder = input.value.trim();
  if (!folder) return;
  changeGroup(g, { folders: [...g.folders, folder] }, `add:${g.id}`);
}

// Asks for a second click, like a to-do's Delete.
function deleteGroup(g, button) {
  if (!button.classList.contains('btn-danger')) {
    button.classList.add('btn-danger');
    button.textContent = 'Delete?';
    setTimeout(() => {
      button.classList.remove('btn-danger');
      button.textContent = 'Delete';
    }, 3000);
    return;
  }
  saveGroups(editedGroups().filter((x) => x.id !== g.id));
}

function groupRow(g) {
  return el(
    'div',
    { class: `group-row g-${g.color}` },
    el(
      'div',
      { class: 'group-row-head' },
      el('span', { class: 'dot' }),
      el('input', {
        type: 'text',
        class: 'group-name',
        value: g.name,
        maxlength: '40',
        'aria-label': 'Group name',
        'data-focus': `name:${g.id}`,
        onchange: (e) => {
          const name = e.currentTarget.value.trim();
          if (name) changeGroup(g, { name });
          else {
            e.currentTarget.value = g.name;
            toast('A group needs a name.', true);
          }
        },
        onkeydown: noSubmit((input) => input.blur()),
      }),
      el('button', { type: 'button', class: 'btn btn-stop', onclick: (e) => deleteGroup(g, e.currentTarget) }, 'Delete'),
    ),
    el(
      'div',
      { class: 'swatches', role: 'radiogroup', 'aria-label': `${g.name}'s colour` },
      Object.entries(GROUP_COLORS).map(([color, label]) =>
        el('button', {
          type: 'button',
          role: 'radio',
          class: `swatch g-${color}`,
          'aria-checked': String(g.color === color),
          'aria-label': label,
          title: label,
          'data-focus': `color:${g.id}:${color}`,
          onclick: () => changeGroup(g, { color }, `color:${g.id}:${color}`),
        }),
      ),
    ),
    g.folders.length
      ? el(
          'ul',
          { class: 'excluded group-folders' },
          g.folders.map((f) =>
            el(
              'li',
              {},
              el('span', { class: 'excluded-path', text: shortPath(f), title: f }),
              el('button', { type: 'button', class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${shortPath(f)}`, onclick: () => changeGroup(g, { folders: g.folders.filter((x) => x !== f) }) }, '✕'),
            ),
          ),
        )
      : el('p', { class: 'settings-help', text: 'No folders yet, so only sessions moved here by hand are in it.' }),
    el(
      'div',
      { class: 'group-add-folder' },
      el('input', {
        type: 'text',
        list: 'group-folders',
        placeholder: 'Add a folder: a full path, or pick a repo',
        'aria-label': `Add a folder to ${g.name}`,
        autocomplete: 'off',
        spellcheck: 'false',
        'data-focus': `add:${g.id}`,
        onkeydown: noSubmit((input) => addGroupFolder(g, input)),
      }),
      el('button', { type: 'button', class: 'btn', onclick: (e) => addGroupFolder(g, e.currentTarget.previousElementSibling) }, 'Add'),
    ),
  );
}

// Rebuilt after each change, with focus put back where it was, or on `focusKey`.
function renderGroupEditor(focusKey) {
  const box = $('group-editor');
  const focused = focusKey || (box.contains(document.activeElement) ? document.activeElement.dataset.focus : null);
  const groups = editedGroups();
  box.replaceChildren(...groups.map(groupRow));
  if (focused) box.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
}

// The repo menu's folders and repos, as suggestions for a group's folders.
function renderFolderSuggestions() {
  if (!repoData?.all) return;
  const sep = repoSep();
  const paths = repoNodes(repoData.all).map((n) => shortPath(`${repoData.root}${sep}${n.path.split('/').join(sep)}`));
  $('group-folders').replaceChildren(...paths.map((value) => el('option', { value })));
}

$('group-add').addEventListener('click', () => {
  const groups = editedGroups();
  const g = { id: crypto.randomUUID(), name: `Group ${groups.length + 1}`, color: freeColor(groups), folders: [] };
  saveGroups([...groups, g], `name:${g.id}`);
  $('group-editor').querySelector(`[data-focus="name:${g.id}"]`)?.select();
});

$('keep-notes').checked = keepNotes;
$('keep-notes').addEventListener('change', (e) => {
  keepNotes = e.currentTarget.checked;
  try {
    localStorage.setItem(KEEP_NOTES_KEY, keepNotes ? 'on' : 'off');
  } catch {}
  saveNotes();
});

// Opens Settings, at one of its sections if given.
function openSettings(sectionId) {
  $('settings').showModal();
  groupsDraft = null;
  renderGroupEditor();
  if (sectionId) $(sectionId).scrollIntoView({ block: 'start' });
  else $('settings').querySelector('input:checked').focus();
  loadServerSettings();
  loadRepos(false);
}

$('settings-button').addEventListener('click', () => openSettings());
$('settings').addEventListener('click', (e) => e.target === e.currentTarget && e.currentTarget.close());
renderNotes();
// Starting a to-do needs the folder setting before Settings is ever opened.
loadServerSettings();

for (const b of document.querySelectorAll('[data-filter]')) {
  b.addEventListener('click', () => {
    filter = b.dataset.filter;
    for (const o of document.querySelectorAll('[data-filter]')) o.setAttribute('aria-pressed', String(o === b));
    render();
  });
}
$('sound').addEventListener('click', () => {
  const ctx = audioContext();
  // While sound is blocked, the first click only unblocks it.
  if (!(soundOn && ctx && ctx.state !== 'running')) {
    soundOn = !soundOn;
    try {
      localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off');
    } catch {}
  }
  const preview = () => {
    updateSoundButton();
    ding('done');
  };
  if (ctx && ctx.state !== 'running') ctx.resume().then(preview, preview);
  else preview();
});
document.addEventListener('pointerdown', unlockAudio, true);
document.addEventListener('keydown', unlockAudio, true);
audioContext();
updateSoundButton();
setInterval(tick, 1000);
connect();
