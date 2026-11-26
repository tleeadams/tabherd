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

// Whether this browser has used the dashboard before, from the settings it
// keeps, read before this visit keeps any. A first visit gets the tour.
let firstVisit = false;
try {
  firstVisit = !Object.keys(localStorage).some((key) => key.startsWith('tabherd:'));
} catch {}

// ---- language ----------------------------------------------------------------

// The page's words are written in English, and tr() gives each in the language
// chosen in Settings → Appearance, from that language's table in public/lang,
// or the English where the table has none. {name} in a text is filled from
// vars. trn() picks the form for a count: a table gives one text for each of
// the English forms, or, for a language with more forms than English, its
// own forms (Intl.PluralRules' one, few, many, other) under the English plural.
const LANGUAGES = { en: 'English', es: 'Español' };
const LANGUAGE_KEY = 'tabherd:language';
// Automatic follows the browser's languages, the first one there's a table for.
const browserLanguage =
  (navigator.languages || [navigator.language]).map((l) => String(l).toLowerCase().split('-')[0]).find((l) => l in LANGUAGES) || 'en';
let languageChoice = 'auto';
try {
  languageChoice = localStorage.getItem(LANGUAGE_KEY) || 'auto';
} catch {}
const lang = languageChoice in LANGUAGES ? languageChoice : browserLanguage;
// Each table is a script in public/lang, loaded before this one.
const phrases = (lang !== 'en' && window.TABHERD_LANGUAGES?.[lang]) || {};
const plurals = new Intl.PluralRules(lang);
const fillIn = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text);
const tr = (text, vars) => fillIn(typeof phrases[text] === 'string' ? phrases[text] : text, vars);
function trn(n, one, other, vars) {
  const forms = phrases[other];
  if (forms && typeof forms === 'object') return fillIn(forms[plurals.select(n)] ?? forms.other, { n, ...vars });
  return tr(n === 1 ? one : other, { n, ...vars });
}

// The page's own text, translated once as it loads. An element marked
// data-i18n is translated whole, markup and all, where the words on either
// side of a <b> or <code> need to move together; elsewhere each piece of text
// is, leaving out code. So are titles, labels and placeholders.
function translatePage() {
  if (lang === 'en') return;
  document.documentElement.lang = lang;
  for (const node of document.querySelectorAll('[data-i18n]')) node.innerHTML = tr(node.innerHTML.replace(/\s+/g, ' ').trim());
  const skip = (n) => n.parentElement.closest('[data-i18n], code, pre, script, style') || !n.nodeValue.trim();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (skip(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue.trim();
    n.nodeValue = n.nodeValue.replace(text, () => tr(text.replace(/\s+/g, ' ')));
  }
  for (const attr of ['title', 'aria-label', 'placeholder', 'data-title', 'alt']) {
    for (const node of document.querySelectorAll(`[${attr}]`)) node.setAttribute(attr, tr(node.getAttribute(attr)));
  }
}
translatePage();

const STATUS = {
  waiting: { label: tr('Needs you'), group: 'needs', rank: 0 },
  busy: { label: tr('Working'), group: 'working', rank: 1 },
  shell: { label: tr('Shell running'), group: 'working', rank: 2, hint: tr('At the prompt while a background shell task runs') },
  // A ComfyUI job or a download waiting its turn.
  queued: { label: tr('Queued'), group: 'working', rank: 3, hint: tr('Waiting for the ones before it') },
  idle: { label: tr('Idle'), group: 'idle', rank: 4 },
  unknown: { label: tr('Starting'), group: 'idle', rank: 5 },
  // A model loaded in LocalAI: not anyone's turn, so in no filter but All.
  loaded: { label: tr('Loaded'), group: 'resource', rank: 6 },
};
// The statuses a filter can pick: status groups, with Shell running apart
// from the rest of Working.
const FILTER_STATUSES = { needs: tr('Needs you'), working: tr('Working'), shell: tr('Shell running'), idle: tr('Idle') };
const filterStatus = (x) => (x.status === 'shell' ? 'shell' : status(x).group);
const MAX_FILTERS = 12;
const PERMISSION_MODES = {
  bypassPermissions: tr('bypass'),
  acceptEdits: tr('accept edits'),
  plan: tr('plan mode'),
  auto: tr('auto'),
  dontAsk: tr("don't ask"),
  'never-ask': tr('never asks'),
};
// Which app each session is, on its card and in the history.
const APPS = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot', opencode: 'OpenCode', cursor: 'Cursor', comfy: 'Comfy', localai: 'LocalAI', ollama: 'Ollama', lmstudio: 'LM Studio', llamacpp: 'llama.cpp' };
// Cards for things other than sessions: ComfyUI's jobs, LocalAI's models,
// downloads and chats, and the other model servers' loaded models.
const isItem = (a) => ['comfy', 'localai', 'ollama', 'lmstudio', 'llamacpp'].includes(a.app);
const APP_HINTS = {
  claude: tr('A Claude Code session'),
  codex: tr('A Codex session'),
  copilot: tr('A GitHub Copilot session'),
  opencode: tr('An OpenCode session'),
  cursor: tr('A Cursor CLI session'),
  comfy: tr('A ComfyUI job'),
  localai: tr('From LocalAI'),
  ollama: tr('From Ollama'),
  lmstudio: tr('From LM Studio'),
  llamacpp: tr("From llama.cpp's server"),
};
const appTag = (x) => el('span', { class: `app app-${x.app || 'claude'}`, title: APP_HINTS[x.app] || APP_HINTS.claude }, APPS[x.app] || APPS.claude);
// The colours a group can have, as the server knows them. Each is set for
// light and dark in the stylesheet, as .g-<name>.
const GROUP_COLORS = {
  rose: tr('Rose'),
  orange: tr('Orange'),
  olive: tr('Olive'),
  teal: tr('Teal'),
  indigo: tr('Indigo'),
  plum: tr('Plum'),
  brown: tr('Brown'),
  slate: tr('Slate'),
};

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

// Seconds, minutes, hours and days, short.
const UNITS = { s: tr('{n}s'), m: tr('{n}m'), h: tr('{n}h'), d: tr('{n}d') };
const unit = (u, n) => fillIn(UNITS[u], { n });

function dur(delta) {
  const s = Math.max(0, Math.floor(delta / 1000));
  if (s < 60) return unit('s', s);
  const m = Math.floor(s / 60);
  if (m < 60) return unit('m', m);
  const h = Math.floor(m / 60);
  if (h < 24) return `${unit('h', h)} ${unit('m', m % 60)}`;
  return `${unit('d', Math.floor(h / 24))} ${unit('h', h % 24)}`;
}

// How long since then, kept up to date by tick(), as "5m ago" with ago.
const sinceText = (at, ago) => (ago ? tr('{time} ago', { time: dur(now() - at) }) : dur(now() - at));

function since(t, ago = false) {
  const at = ms(t);
  if (!Number.isFinite(at)) return null;
  return el('span', { class: 'since', 'data-since': at, 'data-ago': ago, title: new Date(at).toLocaleString(lang) }, sinceText(at, ago));
}

function tick() {
  for (const node of document.querySelectorAll('[data-since]')) {
    node.textContent = sinceText(Number(node.dataset.since), 'ago' in node.dataset);
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
const RESUME = {
  codex: (id) => `codex resume ${id}`,
  copilot: (id) => `copilot --resume=${id}`,
  opencode: (id) => `opencode --session ${id}`,
  cursor: (id) => `cursor-agent --resume ${id}`,
  claude: (id) => `claude --resume ${id}`,
};
const resumeCommand = (a) => `cd "${a.cwd}"; ${(RESUME[a.app] || RESUME.claude)(a.id)}`;
// A Copilot session inside VS Code can only be gone to: VS Code runs it.
const inVsCode = (a) => a.app === 'copilot' && a.entrypoint === 'vscode';

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
  // The server's messages are English; the fixed ones are in the tables too.
  if (!res.ok || !data.ok) throw new Error(data.error ? tr(data.error) : tr('Request failed ({status})', { status: res.status }));
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
// Codex and OpenCode take Catch up's prompt through their own services, so
// they don't need the window; Claude's is typed into the window.
const canCatchUp = (a) => !inVsCode(a) && (a.app === 'codex' || a.app === 'opencode' ? !a.kind || a.kind === 'interactive' : canFocus(a));
// The app a to-do starts: its own choice, or the one Settings names.
const todoApp = (t) => t.app || snap?.newSessionApp || 'claude';

async function goToWindow(a, button) {
  if (button) button.disabled = true;
  try {
    const r = await post(a, 'focus');
    if (r.terminal && !r.tab) toast(tr("Opened {window}, but couldn't tell which tab is {name}", { window: r.window, name: displayName(a) }), true);
    else if (!r.raised)
      toast(
        r.terminal
          ? tr('Found the tab, but Windows kept it in the background. Check the taskbar.')
          : tr('Found {window}, but Windows kept it in the background. Check the taskbar.', { window: r.window }),
        true,
      );
    else toast(r.terminal ? tr('Switched to {name}', { name: displayName(a) }) : tr('Opened {window}', { window: r.window }));
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
    const where = r.raised || (a.app === 'codex' && !a.pid) ? '' : ` ${tr('Its window stayed in the background.')}`;
    const name = displayName(a);
    const asked =
      a.status !== 'busy'
        ? tr('Asked {name} to catch you up.', { name })
        : a.app === 'codex'
          ? tr('Queued for {name}. It will answer after its current turn.', { name })
          : tr('Queued for {name}. It will answer after its current step.', { name });
    toast(asked + where);
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
  const title = g
    ? x.placed
      ? tr('In {group}, put there by hand. Click to change.', { group: g.name })
      : tr('In {group}, by its folder. Click to change.', { group: g.name })
    : x.placed
      ? tr('In no group, put there by hand. Click to choose one.')
      : tr('In no group. Click to choose one.');
  return el(
    'button',
    {
      type: 'button',
      class: g ? `group-chip g-${g.color}` : 'group-chip none',
      title,
      'aria-haspopup': 'menu',
      onclick: (e) => openGroupMenu(x, cwd, e.currentTarget),
    },
    el('span', { class: 'dot' }),
    g ? g.name : tr('No group'),
  );
}

// The group's name in its colour, where it can't be changed, as in History.
function groupTag(x) {
  const g = groupDef(x.group);
  return g ? el('span', { class: `group-chip static g-${g.color}`, title: tr('In {group}', { group: g.name }) }, el('span', { class: 'dot' }), g.name) : null;
}

async function placeIn(x, group) {
  try {
    await api('/api/groups/place', { id: x.id, group });
    const g = groupDef(group);
    toast(group === 'auto' ? tr('Following its folder again') : g ? tr('Moved to {group}', { group: g.name }) : tr('Moved out of its group'));
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
  const name = el('input', { type: 'text', value: baseName(cwd), maxlength: '40', 'aria-label': tr('New group name'), autocomplete: 'off', spellcheck: 'false' });
  const create = async (e) => {
    e.preventDefault();
    const g = { id: crypto.randomUUID(), name: name.value.trim(), color: freeColor(groups), folders: [cwd] };
    if (!g.name) return name.focus();
    try {
      await api('/api/groups', { groups: [...groups, g] });
      // Moved by hand before, it now follows its folder into the new group.
      if (x.placed) await api('/api/groups/place', { id: x.id, group: 'auto' });
      close();
      toast(tr('Made {group} for {folder}', { group: g.name, folder: shortPath(cwd) }));
    } catch (err) {
      toast(err.message, true);
    }
    refresh();
  };
  const items = [
    ...groups.map((g) => item([el('span', { class: `dot g-${g.color}` }), g.name], x.group === g.id, choose(g.id))),
    item([el('span', { class: 'dot none' }), tr('No group')], !x.group, choose(null)),
    x.placed ? item(tr('Follow its folder again'), null, choose('auto'), { title: tr('Go back to the group its folder is in') }) : null,
    el('hr'),
    cwd
      ? el(
          'form',
          { class: 'menu-new', onsubmit: create },
          el('label', { text: tr('New group for {folder}', { folder: shortPath(cwd) }) }),
          el('div', { class: 'menu-new-row' }, name, el('button', { type: 'submit', class: 'btn btn-primary' }, tr('Make'))),
        )
      : null,
    item(tr('Edit groups…'), null, () => {
      close();
      openSettings('groups-setting');
    }),
  ];
  menu.replaceChildren(...items.filter(Boolean));
  showMenu(menu, button);
  menu.querySelector('[aria-checked="true"]')?.focus();
}

// Opens a menu under the button that opened it, kept on screen.
function showMenu(menu, button) {
  menu.showPopover();
  const r = button.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
}

// The address boxes under Settings → Other apps, and the settings they set.
const APP_ADDRESSES = [
  ['comfy-url', 'comfyUrl'],
  ['localai-url', 'localaiUrl'],
  ['ollama-url', 'ollamaUrl'],
  ['lmstudio-url', 'lmstudioUrl'],
  ['llamacpp-url', 'llamacppUrl'],
];

// Codex or the Copilot CLI is installed, so there's an app to choose.
const otherAppsInstalled = () => Boolean(snap?.codexInstalled || snap?.copilotInstalled);

// Only the apps that are installed are offered in a Claude, Codex or Copilot choice.
function showInstalledChoices(name) {
  for (const r of document.querySelectorAll(`input[name="${name}"]`)) {
    r.closest('label').hidden = (r.value === 'codex' && !snap?.codexInstalled) || (r.value === 'copilot' && !snap?.copilotInstalled);
  }
}

// ---- save and close, resume ----------------------------------------------------

// The sessions Save and close takes: Claude's, Codex's, OpenCode's and
// Cursor's in a terminal.
const closable = (a) =>
  (a.app === 'claude' && !a.background && (!a.kind || a.kind === 'interactive') && (!a.entrypoint || a.entrypoint === 'cli')) ||
  a.app === 'codex' ||
  a.app === 'opencode' ||
  a.app === 'cursor' ||
  (a.app === 'copilot' && a.entrypoint === 'cli');
const isWorking = (a) => a.status === 'busy' || a.status === 'shell';

function openSessionsMenu(button) {
  const menu = $('sessions-menu');
  const open = (snap?.agents || []).filter(closable);
  const last = snap?.saved;
  const item = (label, onclick, disabled) => el('button', { type: 'button', class: 'menu-item', role: 'menuitem', disabled: disabled || null, onclick }, label);
  menu.replaceChildren(
    item(open.length ? tr('Save and close all ({n})', { n: open.length }) : tr('No sessions to close'), () => (menu.hidePopover(), confirmSaveClose()), !open.length),
    last?.count
      ? item(
          [
            el('span', { text: tr('Resume last session') }),
            el('span', { class: 'menu-meta', text: tr('{n} · saved {time} ago', { n: last.count, time: dur(now() - last.savedAt) }) }),
          ],
          () => (menu.hidePopover(), resumeLast()),
        )
      : item(tr('No saved session to resume'), null, true),
    snap?.closing?.length
      ? el('p', { class: 'menu-note', text: trn(snap.closing.length, '{n} will close when its turn ends', '{n} will close when their turns end') })
      : null,
  );
  showMenu(menu, button);
}

function confirmSaveClose() {
  const open = (snap?.agents || []).filter(closable);
  const busy = open.filter(isWorking);
  const left = (snap?.agents || []).filter((a) => !closable(a) && !isItem(a) && !a.background);
  $('save-close-title').textContent = trn(open.length, 'Save and close {n} session?', 'Save and close {n} sessions?');
  $('save-close-list').replaceChildren(
    ...open.map((a) => el('li', {}, el('span', { class: 'save-close-name', text: displayName(a) }), el('span', { class: `badge s-${a.status}` }, el('span', { class: 'dot' }), status(a).label))),
  );
  $('save-close-busy').hidden = !busy.length;
  $('save-close-busy-text').textContent = trn(busy.length, '{n} is still working:', '{n} are still working:');
  $('save-close-left').hidden = !left.length;
  $('save-close-left').textContent = left.length ? trn(left.length, '{n} in VS Code or another app stays open.', '{n} in VS Code or another app stay open.') : '';
  const dialog = $('save-close');
  dialog.returnValue = '';
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'save') return;
    const wait = busy.length > 0 && document.querySelector('input[name="save-close-busy"]:checked')?.value === 'wait';
    try {
      const r = await api('/api/sessions/save-close', { wait });
      const parts = [tr('Saved {saved}, closed {closed}', { saved: r.saved, closed: r.closed })];
      if (r.waiting) parts.push(tr('{n} closing when done', { n: r.waiting }));
      if (r.failed.length) parts.push(tr("couldn't close {list}", { list: r.failed.map((f) => `${f.name} (${tr(f.error)})`).join(', ') }));
      toast(parts.join('. '), r.failed.length > 0);
    } catch (err) {
      toast(err.message, true);
    }
    refresh();
  };
  dialog.showModal();
}

async function resumeLast() {
  try {
    const r = await api('/api/sessions/resume-last');
    const skipped = r.skipped.length ? `. ${tr('Skipped {list}', { list: r.skipped.map((s) => `${s.name || tr('one')} (${tr(s.why)})`).join(', ') })}` : '';
    toast(trn(r.opened, 'Opening {n} session', 'Opening {n} sessions') + skipped, r.skipped.length > 0 && !r.opened);
  } catch (err) {
    toast(err.message, true);
  }
}

async function keepOpen(a) {
  try {
    await api('/api/sessions/keep-open', { id: a.id });
    toast(tr('{name} stays open', { name: displayName(a) }));
  } catch (err) {
    toast(err.message, true);
  }
  refresh();
}

$('sessions-button').addEventListener('click', (e) => openSessionsMenu(e.currentTarget));

// ---- card ------------------------------------------------------------------

// Text cut to two lines that a click expands. `id` remembers it across updates.
function expandable(id, text) {
  return el('p', {
    class: 'text',
    text,
    tabindex: '0',
    title: tr('Click to expand'),
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
    el('span', { class: 'label' }, m.at ? [`${label} · `, since(m.at, true)] : label),
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
      el('span', { class: 'label', text: tr('To-do') }),
      el('b', { class: 'todo-msg-title', text: t.title, title: t.title }),
      el('button', { type: 'button', class: 'link-btn', title: tr('Copy the title and notes, to paste into Claude'), onclick: () => copyTodo(t) }, tr('Copy')),
    ),
    t.notes ? expandable(id, t.notes) : null,
  );
}

function nowBlock(a) {
  const rows = [];
  if (a.status === 'waiting') {
    rows.push(el('div', { class: 'now-row' }, el('span', { class: 'what', text: tr('Waiting on you') }), el('span', { class: 'detail', text: tr(a.waitingFor || '') })));
  }
  for (const t of a.tools || []) {
    rows.push(el('div', { class: 'now-row' }, el('span', { class: 'what', text: t.name }), el('span', { class: 'detail', text: t.detail, title: t.detail }), since(t.at)));
  }
  const runningSubs = a.subagents?.running.length || 0;
  if (a.status === 'busy' && !a.tools?.length) {
    const what = runningSubs ? tr('Waiting on subagents') : tr('Thinking');
    const detail = runningSubs ? tr('{n} running', { n: runningSubs }) : '';
    rows.push(el('div', { class: 'now-row' }, el('span', { class: 'what', text: what }), el('span', { class: 'detail', text: detail }), since(a.lastEventAt)));
  }
  if (a.status === 'shell' && !a.tools?.length) {
    rows.push(
      el('div', { class: 'now-row' }, el('span', { class: 'what', text: tr('Background shell') }), el('span', { class: 'detail', text: tr('running while the session waits at the prompt') })),
    );
  }
  if (a.detail) rows.push(el('div', { class: 'now-row' }, el('span', { class: 'detail', text: a.detail })));
  return rows.length ? el('div', { class: `now${a.status === 'waiting' ? ' waiting' : ''}` }, rows) : null;
}

function activity(a) {
  const promptAt = ms(a.lastPrompt?.at) || 0;
  const parts = [todoNote(a), nowBlock(a)];
  const replyFresh = a.lastReply && ms(a.lastReply.at) >= promptAt;
  const recapFresh = a.recap && ms(a.recap.at) >= Math.max(promptAt, replyFresh ? ms(a.lastReply.at) : 0);
  if (recapFresh && a.status !== 'busy') parts.push(message(a, 'recap', tr('Recap'), a.recap));
  else if (replyFresh) parts.push(message(a, 'reply', a.status === 'busy' ? tr('Latest update') : tr('Last reply'), a.lastReply));
  if (a.lastPrompt) parts.push(message(a, 'prompt', tr('Last prompt'), a.lastPrompt, 'prompt'));
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
        { class: 'ctx', title: tr('Context: {used} of {limit} tokens', { used: a.contextTokens.toLocaleString(lang), limit: a.contextLimit.toLocaleString(lang) }) },
        el('span', { class: `bar${pct > 85 ? ' high' : pct > 60 ? ' mid' : ''}` }, fill),
        tr('{used} / {limit} context', { used: tokens(a.contextTokens), limit: tokens(a.contextLimit) }),
      ),
    );
  }
  if (a.outputTokens) items.push(el('span', { title: tr('Output tokens generated this session'), text: tr('{n} out', { n: tokens(a.outputTokens) }) }));
  if (a.prompts) items.push(el('span', { text: trn(a.prompts, '{n} prompt', '{n} prompts') }));
  if (a.compactions) items.push(el('span', { text: trn(a.compactions, '{n} compaction', '{n} compactions') }));
  return items.length ? el('div', { class: 'stats' }, items) : null;
}

function subagents(a) {
  const s = a.subagents;
  if (!s || (!s.running.length && !s.finishedTotal)) return null;
  const open = subsOpen.has(a.id) ? subsOpen.get(a.id) : s.running.length > 0;
  const summary = [tr('Subagents · {n} running', { n: s.running.length })];
  if (s.finishedTotal) summary.push(` · ${tr('{n} finished', { n: s.finishedTotal })}`);
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
        el('span', { class: 'tool', text: tool ? `${tool.name} · ${tool.detail}` : sub.lastReply?.text || tr('Thinking…') }),
      );
    }),
    ...s.finished.map((sub) =>
      el(
        'li',
        { class: `sub ${sub.status}`, title: sub.status === 'done' ? tr('Finished') : tr('Ended without finishing') },
        el('span', { class: 'dot' }),
        el('span', { class: 'type', text: sub.type }),
        el('span', { class: 'desc', text: sub.description, title: sub.description }),
        since(sub.updatedAt, true),
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
    more > 0 ? el('p', { class: 'more', text: tr('and {n} more finished', { n: more }) }) : null,
  );
}

function actions(a) {
  const btn = (label, onclick, cls = '', props = {}) => el('button', { type: 'button', class: `btn ${cls}`, onclick, ...props }, label);
  const waiting = a.status === 'waiting';
  return el(
    'div',
    { class: 'actions' },
    canFocus(a) ? btn(tr('Go to window'), (e) => goToWindow(a, e.currentTarget), 'btn-primary') : null,
    canCatchUp(a)
      ? btn(tr('Catch up'), (e) => catchUp(a, e.currentTarget), 'btn-accent', {
          disabled: waiting,
          title: waiting
            ? tr('Waiting on a prompt or dialog. Answer it with Go to window first.')
            : tr('Go to the window and ask where things stand'),
        })
      : null,
    btn(tr('Open folder'), async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await post(a, 'open-folder');
        toast(tr('Opened {folder}', { folder: shortPath(a.cwd) }));
      } catch (err) {
        toast(err.message, true);
      } finally {
        b.disabled = false;
      }
    }),
    btn(tr('Copy resume command'), async () => {
      await copy(resumeCommand(a));
      toast(tr('Resume command copied'));
    }),
    // The two that end the session, together at the end, wrapping together.
    inVsCode(a)
      ? null
      : el(
          'span',
          { class: 'actions-end' },
          closable(a) && !snap?.closing?.includes(a.id)
            ? btn(armedLabel(`complete:${a.id}`, tr('Complete')), (e) => completeSession(a, e.currentTarget), armedClass(`complete:${a.id}`), {
                'data-armed': `complete:${a.id}`,
                title: tr('Mark it complete and close it. A working session finishes its turn first.'),
              })
            : null,
          btn(tr('Stop…'), () => confirmStop(a), 'btn-stop'),
        ),
  );
}

// Buttons that ask for a second click: Complete, and a job's, model's or
// download's Stop, Cancel and Unload. The first click is kept for three
// seconds by what the button does, as `key`, not by the button, since a card
// is drawn again whenever what it shows changes, which can be every update.
// A button that may be armed is drawn with armedLabel, armedClass and
// data-armed set to its key.
const armed = new Map();
const isArmed = (key) => (armed.get(key) || 0) > Date.now();
const armedLabel = (key, label) => (isArmed(key) ? tr('{label}?', { label }) : label);
const armedClass = (key) => (isArmed(key) ? 'btn-danger' : '');

// True on the second click. The first arms the button, and any copy of it
// drawn in the next three seconds, and says so on it.
function secondClick(key, button, label) {
  if (isArmed(key)) {
    armed.delete(key);
    return true;
  }
  const until = Date.now() + 3000;
  armed.set(key, until);
  button.classList.add('btn-danger');
  button.textContent = tr('{label}?', { label });
  setTimeout(() => {
    if (armed.get(key) !== until) return;
    armed.delete(key);
    for (const shown of document.querySelectorAll(`[data-armed="${CSS.escape(key)}"]`)) {
      shown.classList.remove('btn-danger');
      shown.textContent = label;
    }
  }, 3000);
  return false;
}

// Complete asks for a second click, like Unload, then closes the session,
// once its turn ends if it's working. History keeps it, marked complete. A
// session with tickets opens a dialog instead, to update them first.
async function completeSession(a, button) {
  if (a.tickets?.length) {
    openCompleteDialog(a);
    return;
  }
  if (!secondClick(`complete:${a.id}`, button, tr('Complete'))) return;
  button.disabled = true;
  if (!(await completeNow(a))) button.disabled = false;
}

async function completeNow(a) {
  try {
    const r = await post(a, 'complete');
    toast(r.waiting ? tr('{name} will close when its turn ends', { name: displayName(a) }) : tr('Completed {name}', { name: displayName(a) }));
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  } finally {
    refresh();
  }
}

// ---- completing a session with tickets -----------------------------------------

// Each tracker's ticks in the Complete dialog, kept in this browser.
const TICKS_KEY = 'tabherd:ticket-ticks';
function savedTicks() {
  try {
    return JSON.parse(localStorage.getItem(TICKS_KEY)) || {};
  } catch {
    return {};
  }
}
function keepTicks(rows) {
  const all = savedTicks();
  for (const r of rows) all[r.t.tracker] = { comment: r.comment.checked, move: r.move.checked, publicReply: Boolean(r.pub?.checked) };
  try {
    localStorage.setItem(TICKS_KEY, JSON.stringify(all));
  } catch {}
}

// The comment a ticket is offered: the session that did the work, what it
// said last, and its pull requests. It goes to the ticket as written, so
// it's in English, and can be changed before it's posted.
const APP_NAMES = { claude: 'Claude Code', codex: 'Codex', copilot: 'GitHub Copilot', opencode: 'OpenCode', cursor: 'Cursor CLI' };
function doneComment(a) {
  const said = (a.recap?.text || a.lastReply?.text || '').trim();
  const parts = [`Done in a ${APP_NAMES[a.app] || 'coding'} session (${displayName(a)})${said ? `: ${said}` : '.'}`];
  if (a.prs?.length) parts.push(`Pull requests: ${a.prs.map((p) => p.url).join(', ')}`);
  return parts.join('\n\n');
}

let completing = null;

// What a ticket's row says about moving it to done.
function showMoves(row, options) {
  const moves = options?.moves || [];
  row.moveTo.replaceChildren(...moves.map((m) => el('option', { value: m.id, text: m.name })));
  row.moveTo.hidden = moves.length < 2;
  row.move.disabled = !moves.length || row.done.includes('move');
  if (!moves.length) row.move.checked = false;
  const t = row.t;
  let note = '';
  if (options?.error) note = tr("Can't move it: {problem}", { problem: tr(options.error) });
  else if (t.pullRequest) note = tr("A pull request isn't moved from here.");
  else if (t.category === 'done' || t.category === 'closed') note = tr('Already {status}.', { status: t.status });
  else if (!moves.length) note = tr('Its status has no way to done.');
  else if (t.type === 'zendesk') note = tr('To Solved, which emails the requester.');
  else if (t.type === 'github') note = tr('Closes it as completed.');
  else if (moves.length === 1) note = tr('To {status}', { status: moves[0].name });
  row.moveNote.textContent = note;
}

async function openCompleteDialog(a) {
  const ticks = savedTicks();
  const rows = a.tickets.map((t) => {
    const saved = ticks[t.tracker] || {};
    const check = (label, checked) => {
      const box = el('input', { type: 'checkbox' });
      box.checked = Boolean(checked);
      return [box, el('label', { class: 'check' }, box, label)];
    };
    const [comment, commentLabel] = check(tr('Comment'), saved.comment);
    const text = el('textarea', { rows: 4, maxlength: 20000, 'aria-label': tr('Comment') });
    text.value = doneComment(a);
    text.disabled = !comment.checked;
    comment.addEventListener('change', () => (text.disabled = !comment.checked));
    // Zendesk comments are internal notes unless they're a public reply.
    const [pub, pubLabel] = t.type === 'zendesk' ? check(tr('Public reply'), saved.publicReply) : [null, null];
    const [move, moveLabel] = check(tr('Move to done'), saved.move);
    move.disabled = true;
    const moveTo = el('select', { hidden: true, 'aria-label': tr('Move to') });
    const moveNote = el('span', { class: 'complete-note', text: tr('Checking how it can be moved…') });
    const problem = el('p', { class: 'complete-problem', hidden: true });
    const block = el(
      'div',
      { class: 'complete-ticket' },
      el('div', { class: 'complete-title' }, ticketChip(t), el('span', { class: 'complete-note', text: t.title })),
      el('div', { class: 'checks' }, commentLabel, pubLabel),
      el('div', { class: 'field' }, text),
      pub ? el('p', { class: 'settings-help', text: tr("Without Public reply, it's an internal note. A public reply emails the requester.") }) : null,
      el('div', { class: 'checks' }, moveLabel, moveTo, moveNote),
      problem,
    );
    return { t, comment, text, pub, move, moveTo, moveNote, problem, block, done: [] };
  });
  completing = { a, rows };
  $('complete-name').textContent = displayName(a);
  $('complete-tickets').replaceChildren(...rows.map((r) => r.block));
  $('complete-anyway').hidden = true;
  $('complete-save').disabled = false;
  $('complete-dialog').showModal();
  try {
    const r = await api('/api/tickets/done-options', { id: a.id });
    for (const row of rows) showMoves(row, r.tickets.find((x) => x.chip === row.t.id));
  } catch (err) {
    for (const row of rows) showMoves(row, { moves: [], error: err.message });
  }
}

// Posts what's ticked to the tickets, then completes the session. If any
// fails, the dialog stays, saying why, with Complete anyway. What was posted
// isn't posted again.
$('complete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { a, rows } = completing;
  const save = $('complete-save');
  save.disabled = true;
  try {
    keepTicks(rows);
    const writes = rows
      .map((r) => ({
        chip: r.t.id,
        comment: r.comment.checked && !r.done.includes('comment') ? r.text.value : null,
        publicReply: Boolean(r.pub?.checked),
        move: r.move.checked && !r.move.disabled && !r.done.includes('move') ? r.moveTo.value || null : null,
      }))
      .filter((w) => w.comment || w.move);
    let failed = false;
    if (writes.length) {
      const res = await api('/api/tickets/write', { id: a.id, writes });
      for (const result of res.results) {
        const row = rows.find((r) => r.t.id === result.chip);
        if (!row) continue;
        row.done.push(...result.done);
        if (row.done.includes('comment')) row.comment.disabled = row.text.disabled = true;
        if (row.done.includes('move')) row.move.disabled = true;
        row.problem.hidden = result.ok;
        if (!result.ok) {
          failed = true;
          row.problem.textContent = result.done.includes('comment') ? tr('The comment was posted, but: {problem}', { problem: tr(result.error) }) : tr(result.error);
        }
      }
    }
    if (failed) {
      $('complete-anyway').hidden = false;
      toast(tr("Some tickets weren't updated. Try again, or complete it anyway."), true);
      return;
    }
    $('complete-dialog').close();
    await completeNow(a);
  } catch (err) {
    toast(err.message, true);
  } finally {
    save.disabled = false;
  }
});
$('complete-anyway').addEventListener('click', async () => {
  $('complete-dialog').close();
  await completeNow(completing.a);
});
for (const id of ['complete-cancel', 'complete-close']) $(id).addEventListener('click', () => $('complete-dialog').close());

// A card for a ComfyUI job, or a LocalAI model, download or chat. The server
// gives what it shows, `facts` as label and value pairs, and which buttons it
// has, as `actions`.
function itemCard(a) {
  const st = status(a);
  const can = (action) => (a.actions || []).includes(action);
  const btn = (label, onclick, cls = '', props = {}) => el('button', { type: 'button', class: `btn ${cls}`, onclick, ...props }, label);
  // Stop, Cancel and Unload, which ask for a second click.
  const twice = (action, label) => {
    const key = `${action}:${a.id}`;
    return btn(armedLabel(key, label), (e) => itemAction(a, action, label, e.currentTarget), `btn-stop ${armedClass(key)}`, { 'data-armed': key });
  };
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
      el('span', { class: `badge s-${a.status}`, title: st.hint }, el('span', { class: 'dot' }), a.statusLabel ? tr(a.statusLabel) : st.label),
      since(a.statusSince),
      el('span', { class: 'spacer' }),
      appTag(a),
      proc.length ? el('span', { class: 'proc', text: proc.join(' · ') }) : null,
    ),
    el(
      'h2',
      { class: 'name' },
      canFocus(a) ? el('button', { type: 'button', class: 'name-link', title: tr('Go to its window'), onclick: (e) => goToWindow(a, e.currentTarget) }, tr(a.name)) : tr(a.name),
    ),
    a.host || a.where ? el('div', { class: 'where' }, el('span', { class: 'path', text: [a.host, a.where].filter(Boolean).join(' · ') })) : null,
    el(
      'div',
      { class: 'card-body' },
      a.status === 'waiting' && a.waitingFor
        ? el('div', { class: 'now waiting' }, el('div', { class: 'now-row' }, el('span', { class: 'detail', text: tr(a.waitingFor), title: tr(a.waitingFor) })))
        : null,
      pct !== null
        ? el('div', { class: 'progress', title: `${Math.round(pct)}%` }, el('span', { class: 'bar' }, fill), el('span', { text: `${Math.round(pct)}%` }))
        : null,
      a.preview ? el('img', { class: 'preview', src: a.preview, alt: tr('Output of {name}', { name: tr(a.name) }), loading: 'lazy' }) : null,
      a.facts?.length ? el('dl', { class: 'facts' }, a.facts.flatMap(([k, v]) => [el('dt', { text: tr(k) }), el('dd', { text: tr(v), title: tr(v) })])) : null,
      a.lastReply ? message(a, 'reply', tr('Last reply'), a.lastReply) : null,
    ),
    el(
      'div',
      { class: 'actions' },
      canFocus(a) ? btn(tr('Go to window'), (e) => goToWindow(a, e.currentTarget), 'btn-primary') : null,
      can('open') && a.url
        ? el('a', { class: 'btn btn-primary', href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.openLabel ? tr(a.openLabel) : tr('Open in {app}', { app: APPS[a.app] }))
        : null,
      can('stop') ? twice('stop', tr('Stop')) : null,
      can('cancel') ? twice('cancel', tr('Cancel')) : null,
      can('unload') ? twice('unload', tr('Unload')) : null,
      can('dismiss') ? btn(tr('Clear'), (e) => clearItem(a, e.currentTarget), '', { title: tr('Take this off the dashboard') }) : null,
    ),
  );
}

const ITEM_DONE = { stop: tr('Stopped {name}'), cancel: tr('Cancelled {name}'), unload: tr('Unloaded {name}') };

// A failed job, chat or download, off the dashboard. No second click: it has
// already ended.
async function clearItem(a, button) {
  button.disabled = true;
  try {
    await post(a, 'dismiss');
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
  }
  refresh();
}

// Stop, Cancel and Unload ask for a second click, like a to-do's Delete.
async function itemAction(a, action, label, button) {
  if (!secondClick(`${action}:${a.id}`, button, label)) return;
  button.disabled = true;
  try {
    if (a.leavesWhenDone) stoppedHere.add(a.id);
    const result = await post(a, action);
    // ComfyUI's Unload frees all its models, and says so.
    toast(result?.done ? tr(result.done) : fillIn(ITEM_DONE[action], { name: tr(a.name) }));
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
  if (a.gitBranch) tags.push(el('span', { class: 'tag branch', title: tr('Git branch'), text: `⎇ ${a.gitBranch}` }));
  if (a.kind && a.kind !== 'interactive') tags.push(el('span', { class: 'tag', text: a.kind }));
  if (snap?.closing?.includes(a.id)) {
    tags.push(
      a.completedAt
        ? el(
            'button',
            { type: 'button', class: 'tag closing', title: tr('Marked complete: it closes when this turn ends. Click to keep it open.'), onclick: () => keepOpen(a) },
            `${tr('Completes when done')} ✕`,
          )
        : el(
            'button',
            { type: 'button', class: 'tag closing', title: tr('Save and close will close it when this turn ends. Click to keep it open.'), onclick: () => keepOpen(a) },
            `${tr('Closes when done')} ✕`,
          ),
    );
  }
  if (a.background) {
    tags.push(el('span', { class: 'tag background', title: tr('Running in the background ({how}), with no window', { how: a.entrypoint }), text: tr('Background') }));
  }
  else if (a.entrypoint && a.entrypoint !== 'cli') tags.push(el('span', { class: 'tag', text: a.entrypoint }));
  const perm = PERMISSION_MODES[a.permissionMode];
  if (perm) tags.push(el('span', { class: 'tag', title: tr('Permission mode: {mode}', { mode: a.permissionMode }), text: perm }));
  if (a.version) tags.push(el('span', { text: `v${a.version}` }));

  const heading = displayName(a);
  const subtitle = a.title && a.title.toLowerCase() !== heading.toLowerCase() ? a.title : null;
  // Claude's session name, when the heading is the tab's title; Codex and Copilot head their cards with their session's name.
  const proc = a.app === 'claude' ? [a.name] : [];
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
      el('span', { class: 'proc', title: tr('Session {id}\nStarted {time}', { id: a.id, time: new Date(a.startedAt).toLocaleString(lang) }), text: proc.join(' · ') }),
    ),
    el(
      'h2',
      { class: 'name' },
      canFocus(a)
        ? el('button', { type: 'button', class: 'name-link', title: tr('Go to this session’s window'), onclick: (e) => goToWindow(a, e.currentTarget) }, heading)
        : heading,
    ),
    subtitle ? el('p', { class: 'title', text: subtitle }) : null,
    el('div', { class: 'where' }, el('span', { class: 'path', title: a.cwd, text: shortPath(a.cwd) }), tags),
    ticketRow(a.tickets, { add: () => openTicketDialog(a), remove: (t) => removeTicket(a, t) }),
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

// ---- tickets -------------------------------------------------------------------

// A ticket's key as its chip shows it: a GitHub issue by its repository's
// name and number, without its owner.
const ticketKey = (t) => (t.type === 'github' ? t.key.replace(/^[^/]+\//, '') : t.key);

// A ticket's chip: its key and status, with a dot in its status group's
// colour, opening the ticket. Its title, assignee and tracker show on hover.
function ticketChip(t, remove) {
  const tip = [t.title, t.assignee ? tr('Assigned to {name}', { name: t.assignee }) : null, t.trackerName].filter(Boolean).join('\n');
  const label = [el('span', { class: 'ticket-dot' }), `${ticketKey(t)} · ${t.status}`];
  return el(
    'span',
    { class: `ticket t-${t.category}` },
    t.url ? el('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer', title: tip }, label) : el('span', { title: tip }, label),
    remove ? el('button', { type: 'button', class: 'ticket-x', title: tr('Take {key} off this card', { key: ticketKey(t) }), 'aria-label': tr('Take {key} off this card', { key: ticketKey(t) }), onclick: () => remove(t) }, '✕') : null,
  );
}

// A card's tickets, under its folder, then + Ticket to link one by hand,
// once there's a tracker in Settings → Tickets.
function ticketRow(list, { add, remove } = {}) {
  const adding = Boolean(add && snap?.trackerCount);
  if (!list?.length && !adding) return null;
  return el(
    'div',
    { class: 'tickets' },
    (list || []).map((t) => ticketChip(t, remove)),
    adding ? el('button', { type: 'button', class: 'ticket ticket-add', title: tr('Link a ticket to this session'), onclick: add }, tr('+ Ticket')) : null,
  );
}

let ticketFor = null;

function openTicketDialog(a) {
  ticketFor = a;
  $('ticket-name').textContent = displayName(a);
  $('ticket-text').value = '';
  $('ticket-dialog').showModal();
  $('ticket-text').focus();
}

$('ticket-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const a = ticketFor;
  const button = $('ticket-save');
  button.disabled = true;
  try {
    const r = await api('/api/tickets/add', { id: a.id, text: $('ticket-text').value });
    const said = [];
    if (r.linked.length) said.push(tr('Linked {keys}.', { keys: r.linked.join(', ') }));
    if (r.unsure.length) said.push(tr("{keys}: its tracker didn't answer, so it's linked once it does.", { keys: r.unsure.join(', ') }));
    if (r.notFound.length) said.push(tr('{keys}: not found in your trackers.', { keys: r.notFound.join(', ') }));
    toast(said.join(' '), !r.linked.length && !r.unsure.length);
    if (r.linked.length || r.unsure.length) $('ticket-dialog').close();
    refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
});
for (const id of ['ticket-cancel', 'ticket-close']) $(id).addEventListener('click', () => $('ticket-dialog').close());

// Takes a ticket off a session's card. It stays off, unless it's linked
// again with + Ticket.
async function removeTicket(a, t) {
  try {
    await api('/api/tickets/remove', { id: a.id, chip: t.id });
    toast(tr('{key} taken off. Link it again with + Ticket.', { key: ticketKey(t) }));
    refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

// A to-do's tickets as its Tickets field shows them: one from a link, as
// that link again.
function refText(r) {
  const host = r.hint?.startsWith('host:') ? r.hint.slice(5) : null;
  if (host) return r.key.startsWith('#') ? `https://${host}/agent/tickets/${r.key.slice(1)}` : `https://${host}/browse/${r.key}`;
  return r.hint ? `${r.hint} ${r.key}` : r.key;
}
const refsText = (list) => (list || []).map(refText).join(', ');

// ---- to-dos --------------------------------------------------------------------

// A to-do has its own card until its session starts, then it's on the
// session's card. Card IDs get this prefix so they can't meet a session's.
const TODO_PREFIX = 'todo:';
let editingTodo = null;

const todoText = (t) => (t.notes ? `${t.title}\n\n${t.notes}` : t.title);

async function copyTodo(t) {
  await copy(todoText(t));
  toast(tr('To-do copied'));
}

function editTodo(t) {
  editingTodo = t;
  $('todo-dialog-title').textContent = t ? tr('Edit to-do') : tr('New to-do');
  $('todo-save').textContent = t ? tr('Save') : tr('Add to-do');
  $('todo-title').value = t?.title || '';
  // A new one can be filled in from a ticket.
  $('todo-title').placeholder = !t && snap?.trackerCount ? tr('Or paste a ticket link or key') : '';
  ticketLookup++;
  todoTicketNote('');
  $('todo-notes').value = t?.notes || '';
  // Which app it starts in, once Codex is installed too.
  $('todo-app-field').hidden = !otherAppsInstalled();
  $('todo-app').querySelector('option[value="codex"]').hidden = !snap?.codexInstalled;
  $('todo-app').querySelector('option[value="copilot"]').hidden = !snap?.copilotInstalled;
  $('todo-app-default').textContent = tr('As in Settings ({app})', { app: APPS[snap?.newSessionApp] || APPS.claude });
  $('todo-app').value = t?.app || '';
  // Its tickets, once there's a tracker to look them up in.
  $('todo-tickets-field').hidden = !snap?.trackerCount && !t?.ticketRefs?.length;
  $('todo-tickets').value = refsText(t?.ticketRefs);
  $('todo-dialog').showModal();
  $('todo-title').focus();
}

// A to-do with no folder starts in the one Settings names, where Claude or
// Codex can make a new project.
async function startTodo(t, button) {
  if (button) button.disabled = true;
  try {
    await api(`/api/todos/${t.id}/start`);
    toast(tr('Starting {app} in {folder}', { app: APPS[todoApp(t)], folder: shortPath(t.cwd || snap?.todoStartsIn || '') }));
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
  button.textContent = tr('Choosing…');
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
    button.textContent = tr('{label}?', { label: tr('Delete') });
    setTimeout(() => {
      button.classList.remove('btn-danger');
      button.textContent = tr('Delete');
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
      el('span', { class: `badge s-todo${t.starting ? ' starting' : ''}` }, el('span', { class: 'dot' }), t.starting ? tr('Starting') : tr('To-do')),
      since(t.starting ? t.startedAt : t.createdAt),
      el('span', { class: 'spacer' }),
      groupChip(t, t.cwd || snap?.todoStartsIn),
      // The app it will start, once there's a choice.
      otherAppsInstalled() ? appTag({ app: todoApp(t) }) : null,
    ),
    el('h2', { class: 'name', text: t.title }),
    el(
      'div',
      { class: 'where' },
      t.cwd
        ? el('span', { class: 'path', title: t.cwd, text: shortPath(t.cwd) })
        : el('span', { class: 'no-folder', title: tr('No folder chosen: it starts here, where Claude can make a new project'), text: tr('Starts in {folder}', { folder: startsIn }) }),
    ),
    ticketRow(t.tickets),
    el(
      'div',
      { class: 'card-body' },
      el(
        'div',
        { class: 'activity' },
        t.starting
          ? el(
              'div',
              { class: 'now' },
              el('div', { class: 'now-row' }, el('span', { class: 'what', text: tr('Opening {app}', { app: APPS[todoApp(t)] }) }), el('span', { class: 'detail', text: tr('in a new terminal tab') })),
            )
          : null,
        stalled
          ? el(
              'div',
              { class: 'now waiting' },
              el('div', { class: 'now-row' }, el('span', { class: 'what', text: tr('No session yet') }), el('span', { class: 'detail', text: tr('Check its terminal tab, or start it again') })),
            )
          : null,
        t.notes ? message({ id: TODO_PREFIX + t.id }, 'notes', tr('Notes'), { text: t.notes }, 'todo-text') : null,
      ),
    ),
    el(
      'div',
      { class: 'actions' },
      drivable
        ? btn(stalled ? tr('Start again') : tr('Start'), (e) => startTodo(t, e.currentTarget), 'btn-primary', {
            disabled: t.starting,
            title: tr('Open a terminal tab in {folder} running {app}', { folder: startsIn, app: APPS[todoApp(t)] }),
          })
        : null,
      drivable ? btn(t.cwd ? tr('Change folder') : tr('Choose folder'), (e) => chooseTodoFolder(t, false, e.currentTarget), '', { disabled: t.starting }) : null,
      btn(tr('Copy'), () => copyTodo(t), '', { title: tr('Copy the title and notes, to paste into Claude') }),
      btn(tr('Edit'), () => editTodo(t)),
      btn(tr('Delete'), (e) => deleteTodo(t, e.currentTarget), 'btn-stop'),
    ),
  );
}

$('todo-new').addEventListener('click', () => editTodo(null));
$('todo-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const save = $('todo-save');
  save.disabled = true;
  try {
    const body = { title: $('todo-title').value, notes: $('todo-notes').value, app: $('todo-app').value || null, tickets: $('todo-tickets').value };
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

// A ticket's link or key pasted as a new to-do's title fills the to-do in
// from the ticket: its title, its description as the notes if they're empty,
// and the ticket in Tickets. Only what looks like one is looked up.
const LOOKS_LIKE_TICKET = /^(?:https?:\/\/\S*(?:\/browse\/|selectedIssue=|linear\.app\/\S*\/issue\/|github\.com\/\S*\/issues\/|\/agent\/tickets\/)\S*|[A-Za-z][A-Za-z0-9_]*-\d+|[\w.-]+\/[\w.-]+#\d+)$/;
// Each lookup's number, so one answered after the title changed, or the
// dialog was opened again, is ignored.
let ticketLookup = 0;

// The line under Title: the lookup, what it filled in from, or what went wrong.
function todoTicketNote(text, problem = false) {
  const note = $('todo-from-ticket');
  note.textContent = text;
  note.classList.toggle('problem', problem);
  note.hidden = !text;
}

async function fillTodoFromTicket(pasted) {
  const asked = ++ticketLookup;
  todoTicketNote(tr('Looking up the ticket…'));
  let r;
  try {
    r = await api('/api/tickets/describe', { text: pasted });
  } catch (err) {
    r = { error: err.message };
  }
  // The dialog was opened again, or something else pasted, in the meantime.
  if (asked !== ticketLookup) return;
  // Typed over: what was typed stays.
  if ($('todo-title').value.trim() !== pasted) return todoTicketNote('');
  if (r.error) return todoTicketNote(r.error, true);
  if (!r.ticket) return todoTicketNote('');
  $('todo-title').value = r.ticket.title;
  if (!$('todo-notes').value.trim()) $('todo-notes').value = r.ticket.description;
  const field = $('todo-tickets');
  if (!field.value.includes(pasted)) field.value = field.value.trim() ? `${field.value.trim()}, ${pasted}` : pasted;
  $('todo-tickets-field').hidden = false;
  todoTicketNote(tr('Filled in from {key}, in {tracker}.', { key: r.ticket.key, tracker: r.ticket.trackerName }));
}

$('todo-title').addEventListener('input', (e) => {
  const pasted = $('todo-title').value.trim();
  if (e.inputType === 'insertFromPaste' && !editingTodo && snap?.trackerCount && LOOKS_LIKE_TICKET.test(pasted)) fillTodoFromTicket(pasted);
});

// ---- page ------------------------------------------------------------------

// ---- memory and models ----------------------------------------------------------

// In binary gigabytes, as Task Manager and nvidia-smi count memory.
// With the language's decimal point.
const oneDecimal = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const gb = (n) => (n >= 2 ** 30 ? `${oneDecimal.format(n / 2 ** 30)} GB` : `${Math.round(n / 2 ** 20)} MB`);

// A bar for memory in use, of what there is: amber past three quarters, red
// past nine tenths.
function memoryBar(label, used, total, extra) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  const fill = el('i');
  fill.style.width = `${pct.toFixed(1)}%`;
  const figure = tr('{used} of {total}', { used: gb(used), total: gb(total) }) + (extra ? ` · ${extra}` : '');
  return el(
    'div',
    { class: 'mem-row', title: tr('{label}: {figure}, {pct}% used', { label, figure, pct: Math.round(pct) }) },
    el('span', { class: 'mem-label', text: label }),
    el('span', { class: `bar${pct > 90 ? ' high' : pct > 75 ? ' mid' : ''}` }, fill),
    el('span', { class: 'mem-figure', text: figure }),
  );
}

// What a model takes in memory, for its line on the card. Where all an app
// gives is the model's size, it's about what it takes. Where some or all of
// it isn't in graphics memory, as Ollama says, how much of it is.
function modelMemory(mem) {
  if (!mem) return el('span', { class: 'mem-model-size' });
  const size = gb(mem.used);
  if (mem.about) return el('span', { class: 'mem-model-size', text: `≈ ${size}`, title: tr("{size}, the model's size: about what it takes in memory", { size }) });
  const known = Number.isFinite(mem.graphics);
  const split = known && mem.graphics < mem.used;
  const share = !split ? null : mem.graphics > 0 ? tr('{pct}% GPU', { pct: Math.floor((mem.graphics / mem.used) * 100) }) : tr('CPU only');
  return el('span', {
    class: 'mem-model-size',
    text: [size, share].filter(Boolean).join(' · '),
    title: !known
      ? tr('{size} in memory', { size })
      : !split
        ? tr('{size} in graphics memory', { size })
        : mem.graphics > 0
          ? tr('{size} in memory, {graphics} of it in graphics memory', { size, graphics: gb(mem.graphics) })
          : tr('{size} in memory, none of it in graphics memory', { size }),
  });
}

// What a model's line leaves out of its facts, as its memory says it.
const MEMORY_FACTS = new Set(['Size', 'Graphics memory', 'Memory']);

// The list of models can be closed to its count and what they take
// together. Open unless closed, kept in this browser.
const MODELS_OPEN_KEY = 'tabherd:memory-models';
let modelsOpen = true;
try {
  modelsOpen = localStorage.getItem(MODELS_OPEN_KEY) !== 'closed';
} catch {}

// The card at the top: the computer's RAM and each graphics card's memory,
// used against what there is, and the models loaded in ComfyUI, LocalAI,
// Ollama, LM Studio and llama.cpp, each with what it takes and Unload.
function memoryCard({ memory, models }) {
  const rows = [memoryBar('RAM', memory.ram.used, memory.ram.total)];
  for (const g of memory.gpus || []) rows.push(memoryBar(g.name, g.used, g.total, Number.isFinite(g.busy) ? tr('{pct}% busy', { pct: g.busy }) : null));
  const modelRows = models.map((m) =>
    el(
      'li',
      { class: 'mem-model' },
      appTag(m),
      el('span', { class: 'mem-model-name', text: m.name, title: [m.name, m.where].filter(Boolean).join(' · ') }),
      el('span', {
        class: 'mem-model-facts',
        text: (m.facts || [])
          .filter(([k]) => !(m.memory && MEMORY_FACTS.has(k)))
          .map(([k, v]) => `${tr(k)} ${tr(v)}`)
          .join(' · '),
      }),
      modelMemory(m.memory),
      (m.actions || []).includes('unload')
        ? el(
            'button',
            {
              type: 'button',
              class: `btn btn-stop ${armedClass(`unload:${m.id}`)}`,
              'data-armed': `unload:${m.id}`,
              title: m.app === 'comfy' ? tr("Unloads all of {name}'s models: ComfyUI can't unload one alone", { name: m.host }) : null,
              onclick: (e) => itemAction(m, 'unload', tr('Unload'), e.currentTarget),
            },
            armedLabel(`unload:${m.id}`, tr('Unload')),
          )
        : null,
    ),
  );
  // Together, about what they take if any one's figure is about, or missing.
  const total = models.reduce((sum, m) => sum + (m.memory?.used || 0), 0);
  const about = models.some((m) => !m.memory || m.memory.about);
  const summary = [trn(models.length, '{n} model loaded', '{n} models loaded'), total ? `${about ? '≈ ' : ''}${gb(total)}` : null];
  return el(
    'article',
    { class: 'card memory-card', 'data-id': 'memory' },
    el('div', { class: 'card-head' }, el('h2', { class: 'mem-title', text: tr('Memory and models') })),
    el('div', { class: 'mem-bars' }, rows),
    modelRows.length
      ? el(
          'details',
          {
            class: 'mem-models-box',
            open: modelsOpen,
            ontoggle: (e) => {
              modelsOpen = e.currentTarget.open;
              try {
                localStorage.setItem(MODELS_OPEN_KEY, modelsOpen ? 'open' : 'closed');
              } catch {}
            },
          },
          el('summary', {}, el('span', { class: 'chev' }), summary.filter(Boolean).join(' · ')),
          el('ul', { class: 'mem-models' }, modelRows),
        )
      : el('p', { class: 'mem-none', text: tr('No models loaded in ComfyUI, LocalAI, Ollama, LM Studio or llama.cpp.') }),
  );
}

// The card can be turned off in Settings → Appearance, kept in this browser.
// Loaded models are on it, or in the grid, each with a card of its own, when
// it's off.
const MEMORY_CARD_KEY = 'tabherd:memory-card';
let memoryCardOn = true;
try {
  memoryCardOn = localStorage.getItem(MEMORY_CARD_KEY) !== 'off';
} catch {}
const onMemoryCard = (a) => memoryCardOn && a.kind === 'model';
$('memory-card').checked = memoryCardOn;
$('memory-card').addEventListener('change', (e) => {
  memoryCardOn = e.currentTarget.checked;
  try {
    localStorage.setItem(MEMORY_CARD_KEY, memoryCardOn ? 'on' : 'off');
  } catch {}
  $('memory-float').disabled = !memoryCardOn;
  render();
});

// It can also stay in view, under the header, while the cards scroll. Off
// unless chosen, kept in this browser.
const MEMORY_FLOAT_KEY = 'tabherd:memory-float';
let memoryFloat = false;
try {
  memoryFloat = localStorage.getItem(MEMORY_FLOAT_KEY) === 'on';
} catch {}
list.classList.toggle('memory-float', memoryFloat);
$('memory-float').checked = memoryFloat;
$('memory-float').disabled = !memoryCardOn;
$('memory-float').addEventListener('change', (e) => {
  memoryFloat = e.currentTarget.checked;
  try {
    localStorage.setItem(MEMORY_FLOAT_KEY, memoryFloat ? 'on' : 'off');
  } catch {}
  list.classList.toggle('memory-float', memoryFloat);
});
// The header wraps onto more lines in a narrow window, so the card stops
// wherever its bottom is.
new ResizeObserver(([entry]) => document.documentElement.style.setProperty('--top-height', `${entry.target.offsetHeight}px`)).observe(
  document.querySelector('.top'),
);

// A group's heading, when the cards are in sections by group. It closes the
// section, hiding its cards, and opens it again. A closed one says how many
// of its sessions need you.
function sectionHead(s) {
  return el(
    'h2',
    { class: `section-head${s.color ? ` g-${s.color}` : ' none'}` },
    el(
      'button',
      { type: 'button', class: 'section-toggle', 'data-section': s.key, 'aria-expanded': String(!s.closed), onclick: () => toggleSection(s.key) },
      el('span', { class: 'chev' }),
      el('span', { class: 'dot' }),
      s.name,
      el('b', { text: String(s.count) }),
    ),
    s.waiting ? el('span', { class: 'badge s-waiting' }, el('span', { class: 'dot' }), trn(s.waiting, '{n} needs you', '{n} need you')) : null,
  );
}

// The sections closed, by group, or "none" for the one of cards in no group.
// Kept in this browser, like Sections by group.
const CLOSED_SECTIONS_KEY = 'tabherd:closed-sections';
let closedSections = new Set();
try {
  closedSections = new Set(JSON.parse(localStorage.getItem(CLOSED_SECTIONS_KEY) || '[]'));
} catch {}

function toggleSection(key) {
  if (!closedSections.delete(key)) closedSections.add(key);
  try {
    localStorage.setItem(CLOSED_SECTIONS_KEY, JSON.stringify([...closedSections]));
  } catch {}
  render();
  // The heading is made again, so the keyboard stays on it.
  list.querySelector(`.section-toggle[data-section="${CSS.escape(key)}"]`)?.focus();
}

// The app and group chosen in the header narrow everything, the filters'
// counts included. To-dos start Claude, so they count as Claude's.
const inView = (x) =>
  (appFilter === 'all' || (x.app || 'claude') === appFilter) && (groupFilter === 'all' || (groupFilter === 'none' ? !x.group : x.group === groupFilter));

function render() {
  if (!snap) return;
  renderViewFilters();
  const models = snap.agents.filter((a) => onMemoryCard(a) && inView(a));
  const agents = snap.agents
    .filter((a) => !onMemoryCard(a) && inView(a))
    .sort((x, y) => status(x).rank - status(y).rank || x.startedAt - y.startedAt);
  const todos = (snap.todos || []).filter(inView).sort((x, y) => x.createdAt - y.createdAt);
  renderFilterTabs(agents, todos);
  // The tab's title counts every session that needs you, whatever's shown.
  const needsYou = snap.agents.filter((a) => a.status === 'waiting').length;
  document.title = needsYou ? `(${needsYou}) Tabherd` : 'Tabherd';
  $('host').textContent = snap.host;
  $('version').textContent = snap.version ? `v${snap.version}` : '';

  // To-do cards come first, under All and the filters that ask for them.
  const f = filterDef(filter);
  let shown = [
    ...todos.filter((t) => matchesFilter(f, t, true)).map((t) => [TODO_PREFIX + t.id, t, todoCard]),
    ...agents.filter((a) => matchesFilter(f, a, false)).map((a) => [a.id, a, card]),
  ];
  // In sections: each group's cards under its heading, in the groups' order,
  // then those in no group. A closed section is its heading alone.
  if (sectionsOn && snap.groups?.length) {
    const items = shown;
    shown = [];
    for (const id of [...snap.groups.map((g) => g.id), null]) {
      const inGroup = items.filter(([, d]) => (d.group || null) === id);
      if (!inGroup.length) continue;
      const g = groupDef(id);
      const key = id || 'none';
      const closed = closedSections.has(key);
      const waiting = closed ? inGroup.filter(([, d]) => d.status === 'waiting').length : 0;
      shown.push([`section:${id}`, { key, name: g ? g.name : tr('No group'), color: g?.color || null, count: inGroup.length, closed, waiting }, sectionHead]);
      if (!closed) shown.push(...inGroup);
    }
  }
  // The memory card comes first, whatever the filter.
  if (memoryCardOn && snap.memory) shown.unshift(['memory', { memory: snap.memory, models }, memoryCard]);
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
  $('empty').querySelector('.empty-title').textContent = nothing ? tr('No Claude Code or Codex sessions are running.') : tr('No sessions match this filter.');
}

// The app and group filters in the header. Each shows once there's a choice:
// the app filter once a Codex session is running, the group filter once
// there are groups. Kept in this browser.
const VIEW_KEY = 'tabherd:view';
let appFilter = 'all';
let groupFilter = 'all';
try {
  const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
  if (['all', ...Object.keys(APPS)].includes(saved.app)) appFilter = saved.app;
  if (typeof saved.group === 'string') groupFilter = saved.group;
  if (typeof saved.filter === 'string') filter = saved.filter;
} catch {}

function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ app: appFilter, group: groupFilter, filter }));
  } catch {}
}

function renderViewFilters() {
  const groups = snap?.groups || [];
  if (!['all', 'none'].includes(groupFilter) && !groups.some((g) => g.id === groupFilter)) groupFilter = 'all';
  const app = $('app-filter');
  // Claude, and each other app with something on the dashboard.
  const apps = ['claude', ...Object.keys(APPS).filter((k) => k !== 'claude' && (k === appFilter || snap.agents.some((a) => a.app === k)))];
  app.hidden = appFilter === 'all' && apps.length < 2;
  const appOptions = [['all', tr('All apps')], ...apps.map((k) => [k, APPS[k]])];
  if (app.dataset.signature !== JSON.stringify(appOptions)) {
    app.replaceChildren(...appOptions.map(([value, text]) => el('option', { value, text })));
    app.dataset.signature = JSON.stringify(appOptions);
  }
  app.value = appFilter;
  const select = $('group-filter');
  select.hidden = !groups.length && groupFilter === 'all';
  const options = [['all', tr('All groups')], ...groups.map((g) => [g.id, g.name]), ['none', tr('No group')]];
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

// ---- filters -------------------------------------------------------------------

// The tabs across the top: All, then the filters kept on the server, in their
// order, then the filters' menu. Each can pick statuses, apps, groups and
// words; a list left empty matches any.
const filterDef = (id) => (snap?.filters || []).find((f) => f.id === id) || null;

// Whether a card shows under a filter, or under All (null). To-do cards have
// no status, so they show under the filters that ask for them.
function matchesFilter(f, x, isTodo) {
  if (!f) return true;
  if (isTodo ? !f.todos : f.statuses.length && !f.statuses.includes(filterStatus(x))) return false;
  if (f.apps.length && !f.apps.includes(x.app || 'claude')) return false;
  if (f.groups.length && !f.groups.includes(x.group || 'none')) return false;
  if (f.text) {
    const words = [x.name, x.title, x.cwd, x.where].filter(Boolean).join(' ').toLowerCase();
    if (!f.text.toLowerCase().split(' ').every((w) => words.includes(w))) return false;
  }
  return true;
}

// What a filter shows, in words, like "Needs you or Idle, and to-dos".
const anyOf = new Intl.ListFormat(lang, { type: 'disjunction' });

function describeFilter(f) {
  const or = (ids, name) => anyOf.format(ids.map(name).filter(Boolean));
  return [
    f.statuses.length ? or(f.statuses, (s) => FILTER_STATUSES[s]) : tr('Any status'),
    f.apps.length ? or(f.apps, (a) => APPS[a]) : null,
    f.groups.length ? tr('in {groups}', { groups: or(f.groups, (g) => (g === 'none' ? tr('no group') : groupDef(g)?.name)) }) : null,
    f.text ? `“${f.text}”` : null,
    f.todos ? tr('and to-dos') : null,
  ]
    .filter(Boolean)
    .join(', ');
}

function chooseFilter(id) {
  filter = id;
  saveView();
  render();
}

// Each tab with how many cards it shows, amber when one of them needs you.
function renderFilterTabs(agents, todos) {
  const filters = snap.filters || [];
  if (filter !== 'all' && !filterDef(filter)) filter = 'all';
  const nav = $('filters');
  const tabs = [{ id: 'all', name: tr('All') }, ...filters];
  const signature = JSON.stringify([tabs, snap.groups]);
  if (nav.dataset.signature !== signature) {
    nav.replaceChildren(
      ...tabs.map((f) =>
        el(
          'button',
          {
            type: 'button',
            'data-filter': f.id,
            title: f.id === 'all' ? tr('Everything') : describeFilter(f),
            onclick: () => chooseFilter(f.id),
          },
          `${tr(f.name)} `,
          el('b', { text: '0' }),
        ),
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'filter-menu-button',
          title: tr('New filter, or change the filters'),
          'aria-label': tr('Filter options'),
          'aria-haspopup': 'menu',
          onclick: (e) => openFilterMenu(e.currentTarget),
        },
        '⋯',
      ),
    );
    nav.dataset.signature = signature;
  }
  for (const b of nav.querySelectorAll('[data-filter]')) {
    const f = filterDef(b.dataset.filter);
    const matched = agents.filter((a) => matchesFilter(f, a, false));
    b.querySelector('b').textContent = matched.length + todos.filter((t) => matchesFilter(f, t, true)).length;
    b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
    b.classList.toggle('has', !!f && matched.some((a) => a.status === 'waiting'));
  }
}

// The menu at the end of the tabs: a new filter, the one shown, or all of
// them in Settings.
function openFilterMenu(button) {
  const menu = $('filter-menu');
  const shown = filterDef(filter);
  const full = (snap?.filters || []).length >= MAX_FILTERS;
  const item = (label, onclick, disabled) =>
    el('button', { type: 'button', class: 'menu-item', role: 'menuitem', disabled: disabled || null, onclick: () => (menu.hidePopover(), onclick()) }, label);
  // All isn't a filter of its own, so with it shown there's none to change.
  const items = [
    item(full ? tr('New filter (up to {n})', { n: MAX_FILTERS }) : tr('New filter…'), () => editFilter(null), full),
    shown ? item(tr('Edit “{name}”…', { name: tr(shown.name) }), () => editFilter(shown)) : null,
    el('hr'),
    item(tr('Edit filters…'), () => openSettings('filters-setting')),
  ];
  menu.replaceChildren(...items.filter(Boolean));
  showMenu(menu, button);
}

// Every filter at once, one save at a time, in order; `null` puts the usual
// ones back. Resolves to the filters as saved.
let filtersSaving = Promise.resolve();

function saveFilters(next) {
  const run = filtersSaving.then(async () => {
    const saved = (await api('/api/filters', next ? { filters: next } : { reset: true })).filters;
    if (snap) snap = { ...snap, filters: saved };
    render();
    renderFilterSettings();
    return saved;
  });
  filtersSaving = run.catch(() => {});
  return run;
}

// Asks for a second click, like a group's Delete.
function askTwice(button, then) {
  if (button.classList.contains('btn-danger')) return then();
  const label = button.textContent;
  button.classList.add('btn-danger');
  button.textContent = tr('{label}?', { label });
  setTimeout(() => {
    button.classList.remove('btn-danger');
    button.textContent = label;
  }, 3000);
}

let editingFilter = null;

// A tick box for each choice.
function filterChecks(box, options, chosen) {
  box.replaceChildren(
    ...options.map(([value, text, color]) =>
      el('label', { class: `check${color ? ` g-${color}` : ''}` }, el('input', { type: 'checkbox', value, checked: chosen.includes(value) }), color ? el('span', { class: 'dot' }) : null, text),
    ),
  );
}

function filterFromForm() {
  const ticked = (id) => [...$(id).querySelectorAll('input:checked')].map((i) => i.value);
  const name = $('filter-name').value;
  return {
    ...(editingFilter || {}),
    // One of the usual filters, shown in another language, keeps its name.
    name: editingFilter && name === tr(editingFilter.name) ? editingFilter.name : name,
    statuses: ticked('filter-statuses'),
    apps: ticked('filter-apps'),
    groups: ticked('filter-groups'),
    text: $('filter-text').value.replace(/\s+/g, ' ').trim(),
    todos: $('filter-todos').checked,
  };
}

// How many cards it would show now, as it's changed.
function showFilterCount() {
  if (!snap) return;
  const f = filterFromForm();
  const n =
    snap.agents.filter((a) => !onMemoryCard(a) && inView(a) && matchesFilter(f, a, false)).length +
    (snap.todos || []).filter((t) => inView(t) && matchesFilter(f, t, true)).length;
  $('filter-count').textContent = trn(n, 'Shows {n} card now.', 'Shows {n} cards now.');
}

// Opens the editor, for a new filter if `f` is null.
function editFilter(f) {
  editingFilter = f;
  $('filter-dialog-title').textContent = f ? tr('Edit filter') : tr('New filter');
  $('filter-save').textContent = f ? tr('Save') : tr('Add filter');
  $('filter-delete').hidden = !f;
  $('filter-name').value = f ? tr(f.name) : '';
  filterChecks($('filter-statuses'), Object.entries(FILTER_STATUSES), f?.statuses || []);
  // Every app, so a filter can be made before an app has anything running.
  filterChecks($('filter-apps'), Object.entries(APPS), f?.apps || []);
  const groups = snap?.groups || [];
  $('filter-groups-field').hidden = !groups.length;
  filterChecks($('filter-groups'), [...groups.map((g) => [g.id, g.name, g.color]), ['none', tr('No group')]], f?.groups || []);
  $('filter-text').value = f?.text || '';
  $('filter-todos').checked = !!f?.todos;
  showFilterCount();
  $('filter-dialog').showModal();
  $('filter-name').focus();
}

$('filter-form').addEventListener('input', showFilterCount);
$('filter-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = filterFromForm();
  const filters = snap?.filters || [];
  const next = editingFilter ? filters.map((x) => (x.id === editingFilter.id ? f : x)) : [...filters, f];
  const save = $('filter-save');
  save.disabled = true;
  try {
    const saved = await saveFilters(next);
    $('filter-dialog').close();
    // A new filter is shown as soon as it's made.
    if (!editingFilter) chooseFilter(saved[saved.length - 1].id);
  } catch (err) {
    toast(err.message, true);
  } finally {
    save.disabled = false;
  }
});
$('filter-delete').addEventListener('click', (e) =>
  askTwice(e.currentTarget, async () => {
    try {
      await saveFilters((snap?.filters || []).filter((x) => x.id !== editingFilter.id));
      $('filter-dialog').close();
    } catch (err) {
      toast(err.message, true);
    }
  }),
);
for (const id of ['filter-cancel', 'filter-close']) $(id).addEventListener('click', () => $('filter-dialog').close());

// The list in Settings: each filter with what it shows, to move, change or delete.
function renderFilterSettings(focusKey) {
  const filters = snap?.filters || [];
  const box = $('filter-list');
  const focused = focusKey || (box.contains(document.activeElement) ? document.activeElement.dataset.focus : null);
  const move = (i, by, key) => {
    const next = [...filters];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    saveFilters(next)
      .then(() => box.querySelector(`[data-focus="${CSS.escape(key)}"]:not(:disabled)`)?.focus())
      .catch((err) => toast(err.message, true));
  };
  box.replaceChildren(
    ...filters.map((f, i) =>
      el(
        'li',
        { class: 'filter-row' },
        el('div', { class: 'filter-row-text' }, el('b', { text: tr(f.name) }), el('span', { text: describeFilter(f) })),
        el(
          'button',
          { type: 'button', class: 'icon-btn', title: tr('Move up'), 'aria-label': tr('Move {name} up', { name: tr(f.name) }), 'data-focus': `up:${f.id}`, disabled: i === 0, onclick: () => move(i, -1, `up:${f.id}`) },
          '↑',
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            title: tr('Move down'),
            'aria-label': tr('Move {name} down', { name: tr(f.name) }),
            'data-focus': `down:${f.id}`,
            disabled: i === filters.length - 1,
            onclick: () => move(i, 1, `down:${f.id}`),
          },
          '↓',
        ),
        el('button', { type: 'button', class: 'btn', onclick: () => editFilter(f) }, tr('Edit')),
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn-stop',
            onclick: (e) => askTwice(e.currentTarget, () => saveFilters(filters.filter((x) => x.id !== f.id)).catch((err) => toast(err.message, true))),
          },
          tr('Delete'),
        ),
      ),
    ),
  );
  if (!filters.length) box.append(el('li', { class: 'filter-none', text: tr('Only All, for now.') }));
  $('filter-add').disabled = filters.length >= MAX_FILTERS;
  if (focused) box.querySelector(`[data-focus="${CSS.escape(focused)}"]:not(:disabled)`)?.focus();
}

$('filter-add').addEventListener('click', () => editFilter(null));
$('filter-reset').addEventListener('click', (e) => askTwice(e.currentTarget, () => saveFilters(null).catch((err) => toast(err.message, true))));

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
  $('sound-label').textContent = blocked ? tr('Click to enable sound') : '';
  button.title = !soundOn
    ? tr('Sound is off. Click to ding when an agent needs you or finishes.')
    : blocked
      ? tr('The browser blocks sound until you click the page')
      : tr('Dings when an agent needs you or finishes. Click to mute.');
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
      // How it ended, and its output, if the server knows: a ComfyUI job.
      if ((a.background || a.leavesWhenDone) && !running.has(id) && !stoppedHere.delete(id)) {
        done.push({ ...a, finished: snap?.finished?.find((f) => f.id === id) || null });
      }
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
  const [one] = needs.length ? needs : done;
  const name = displayName(one);
  if (needs.length > 1) toast(tr('{n} agents need you', { n: needs.length }));
  else if (needs.length) toast(one.waitingFor ? tr('{name} needs you: {what}', { name, what: tr(one.waitingFor) }) : tr('{name} needs you', { name }));
  else toast(done.length > 1 ? tr('{n} agents finished', { n: done.length }) : tr('{name} finished', { name }));
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
    ...done.map((a) => ({
      id: a.id,
      kind: 'done',
      name: displayName(a),
      detail: '',
      background: Boolean(a.background),
      // Gone once it's done, so its leaving isn't a session closing.
      gone: Boolean(a.background || a.leavesWhenDone),
      label: a.finished?.label || null,
      preview: a.finished?.preview || null,
      at: snap.now,
    })),
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
  const key = JSON.stringify(rows.map((r) => [r.n.id, r.n.kind, r.n.at, r.name, Boolean(r.a), r.focus, resumable(r.n), r.n.preview]));
  if (key === notesKey) return;
  notesKey = key;
  $('notes-list').replaceChildren(
    ...rows.map(({ n, a, name, focus }) => {
      const what = [
        n.kind === 'update'
          ? tr('A new version is out')
          : n.kind === 'needs'
            ? n.detail
              ? tr('Needs you: {what}', { what: tr(n.detail) })
              : tr('Needs you')
            : n.label
              ? tr(n.label)
              : n.background
                ? tr('Finished in the background')
                : tr('Finished'),
      ];
      if (!a && !n.gone && !n.background && n.kind !== 'update') what.push(tr('session closed'));
      return el(
        'li',
        { class: `note k-${n.kind}` },
        el('span', { class: 'dot' }),
        el(
          'span',
          { class: 'note-text' },
          n.kind === 'update'
            ? el('button', { type: 'button', class: 'name-link note-name', title: tr("See what's new, and how to update"), onclick: () => openUpdate() }, name)
            : focus
              ? el('button', { type: 'button', class: 'name-link note-name', title: tr('Go to this session’s window'), onclick: (e) => goToWindow(a, e.currentTarget) }, name)
              : !a && resumable(n)
                ? el(
                    'button',
                    { type: 'button', class: 'name-link note-name', title: tr('Open a terminal tab in its folder and continue the conversation'), onclick: (e) => resumeNote(n, e.currentTarget) },
                    name,
                  )
                : el('span', { class: 'note-name', text: name }),
          el('span', { class: 'note-what', text: what.join(' · '), title: what.join(' · ') }),
          n.preview ? el('img', { class: 'note-preview', src: n.preview, alt: tr('Output of {name}', { name }), loading: 'lazy' }) : null,
        ),
        since(n.at, true),
        el('button', { type: 'button', class: 'icon-btn note-clear', title: tr('Clear'), 'aria-label': tr('Clear {name}', { name }), onclick: () => clearNotes(n) }, '✕'),
      );
    }),
  );
  $('notes-empty').hidden = notes.length > 0;
  $('notes-clear').hidden = !notes.length;
  $('n-notes').textContent = notes.length || '';
  const needCount = notes.filter((n) => n.kind === 'needs').length;
  $('notes-button').classList.toggle('has-needs', needCount > 0);
  $('notes-button').title = notes.length
    ? trn(notes.length, '{n} notification', '{n} notifications') + (needCount ? `, ${tr('{n} needing you', { n: needCount })}` : '')
    : tr('Notifications');
}

$('notes-clear').addEventListener('click', () => clearNotes());

// Resumes a finished background run from its notification, as History does.
async function resumeNote(n, button) {
  button.disabled = true;
  try {
    await api(`/api/history/${n.id}/resume`);
    toast(tr('Resuming {name}', { name: n.name }));
    clearNotes(n);
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

// ---- update alerts -------------------------------------------------------------

// When a newer Tabherd is out, the header has an Update to button and the
// notification list says so, once. Not now hides the button until the next
// version, in this browser. The server only checks once Settings says yes,
// which a bar above the cards asks once, after any first-run tour.
const UPDATE_DISMISSED_KEY = 'tabherd:update-dismissed';
const UPDATE_NOTED_KEY = 'tabherd:update-noted';
let updateDismissed = null;
let updateNoted = null;
try {
  updateDismissed = localStorage.getItem(UPDATE_DISMISSED_KEY);
  updateNoted = localStorage.getItem(UPDATE_NOTED_KEY);
} catch {}

// How to update, for each way the server can tell Tabherd was installed.
const HOW_TO_UPDATE = {
  git: { text: tr('This copy runs from a clone of the repository. Pull the new version, then start the server again:'), command: 'git pull' },
  homebrew: { text: tr('Installed with Homebrew:'), command: 'brew upgrade tabherd' },
  winget: { text: tr('Installed with winget:'), command: 'winget upgrade tleeadams.Tabherd' },
  'windows-installer': { text: tr('Download the new installer from the release and run it. It installs over this version.') },
  'windows-zip': { text: tr("Download the new zip from the release, and put its folder in place of this one's.") },
  'mac-app': { text: tr('Download the new disk image from the release, and drag Tabherd to Applications, replacing this version.') },
  'linux-package': { text: tr('Download the new .deb or .rpm from the release, and install it as you did this one.') },
  appimage: { text: tr('Download the new AppImage from the release, and use it in place of this one.') },
  archive: { text: tr("Download the new archive for your system from the release, and unpack it in place of this one's folder.") },
};

function showUpdates() {
  const u = snap.updates;
  if (!u) return;
  const latest = u.latest;
  $('update-button').hidden = !latest || updateDismissed === latest.version;
  if (latest) $('update-label').textContent = tr('Update to {version}', { version: latest.version });
  // Asked once for every browser, as the server keeps the answer, but not
  // over the first-run tour.
  $('update-ask').hidden = u.check !== null || tourOn || tourPending;
  if (latest && updateNoted !== latest.version) {
    updateNoted = latest.version;
    try {
      localStorage.setItem(UPDATE_NOTED_KEY, updateNoted);
    } catch {}
    notes = [{ id: `update:${latest.version}`, kind: 'update', name: `Tabherd ${latest.version}`, detail: '', at: snap.now }, ...notes.filter((n) => n.kind !== 'update')];
    saveNotes();
    renderNotes();
  }
  if ($('settings').open) renderUpdateSetting();
}

// Settings → Help: whether to check, and what the last check found.
function renderUpdateSetting() {
  const u = snap?.updates;
  $('update-check').checked = u?.check === true;
  // A prerelease always hears of the next one, so the choice is made.
  $('update-prereleases').checked = Boolean(u?.prereleases);
  $('update-prereleases').disabled = Boolean(u?.onPrerelease);
  $('update-prereleases-note').hidden = !u?.onPrerelease;
  if (!u) return;
  const said = [tr('This is Tabherd {version}.', { version: u.version })];
  if (u.latest) said.push(tr('{version} is out.', { version: u.latest.version }));
  else if (u.checkedAt) said.push(tr('It’s the latest: checked {time}.', { time: sinceText(u.checkedAt, true) }));
  if (u.error) said.push(tr("The last check didn't reach GitHub: {error}", { error: u.error }));
  $('update-status').textContent = said.join(' ');
}

// A release's notes, from GitHub's Markdown, as plain paragraphs and lists:
// links, bold and code show as their text. The line every release starts
// with, saying what Tabherd is, and the link to the signing policy are left out.
function releaseNotes(markdown) {
  const plain = (s) =>
    s
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|`/g, '')
      .replace(/(^|\W)\*([^*]+)\*/g, '$1$2')
      .trim();
  const blocks = [];
  let items = null;
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const text = line.trim();
    const item = /^[-*]\s+(.*)$/.exec(text);
    if (!text || text.startsWith('**Tabherd** is a dashboard') || text.startsWith('[Code signing policy]')) items = null;
    else if (item) {
      if (!items) blocks.push((items = el('ul')));
      items.append(el('li', { text: plain(item[1]) }));
    } else {
      items = null;
      blocks.push(el('p', { text: plain(text) }));
    }
  }
  return blocks;
}

// What's new in the newer version, and how to update this copy.
async function openUpdate() {
  let info = null;
  try {
    const res = await fetch('/api/updates', { cache: 'no-store' });
    if (res.ok) info = await res.json();
  } catch {}
  const latest = info?.latest;
  if (!latest) return toast(tr("There's no newer version."));
  const dialog = $('update-dialog');
  $('update-title').textContent = tr('Tabherd {version} is out', { version: latest.version });
  $('update-current').textContent = [
    tr('You have {version}.', { version: info.version }),
    latest.prerelease ? tr('This one is a prerelease, to try before a release has it.') : '',
  ]
    .filter(Boolean)
    .join(' ');
  $('update-notes').replaceChildren(...releaseNotes(latest.notes));
  const how = HOW_TO_UPDATE[info.install] || HOW_TO_UPDATE.archive;
  $('update-how').textContent = how.text;
  $('update-command').hidden = !how.command;
  $('update-command-text').textContent = how.command || '';
  $('update-release').href = latest.url;
  dialog.dataset.version = latest.version;
  dialog.returnValue = '';
  dialog.showModal();
}

async function answerUpdateCheck(yes) {
  if (!(await saveServerSetting({ updateCheck: yes }))) return;
  $('update-ask').hidden = true;
  toast(yes ? tr('Tabherd will tell you when a new version is out.') : tr("It won't check. Settings → Help can turn it on."));
  refresh();
}

$('update-button').addEventListener('click', () => openUpdate());
$('update-ask-yes').addEventListener('click', () => answerUpdateCheck(true));
$('update-ask-no').addEventListener('click', () => answerUpdateCheck(false));
$('update-copy').addEventListener('click', async () => {
  await copy($('update-command-text').textContent);
  toast(tr('Command copied'));
});
$('update-dialog').addEventListener('close', (e) => {
  const dialog = e.currentTarget;
  if (dialog.returnValue !== 'later') return;
  updateDismissed = dialog.dataset.version;
  try {
    localStorage.setItem(UPDATE_DISMISSED_KEY, updateDismissed);
  } catch {}
  $('update-button').hidden = true;
});
$('update-check').addEventListener('change', (e) => saveServerSetting({ updateCheck: e.currentTarget.checked }).then(() => refresh()));
$('update-prereleases').addEventListener('change', (e) => saveServerSetting({ updatePrereleases: e.currentTarget.checked }).then(() => refresh()));
// Check now asks whatever the setting is, as it's asked for.
$('update-now').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    const u = await api('/api/updates/check');
    toast(u.latest ? tr('Tabherd {version} is out', { version: u.latest.version }) : tr('You have the latest version.'));
    await refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
});

function apply(next) {
  snap = next;
  clockSkew = snap.now - Date.now();
  $('conn').className = 'conn live';
  $('updated').textContent = tr('Live · {time}', { time: new Date(snap.now).toLocaleTimeString(lang) });
  list.classList.remove('stale');
  const changes = notableChanges(snap.agents);
  // The cards hold still while the tour runs; dings and notifications don't.
  if (!tourOn) render();
  announce(changes);
  updateNotes(snap.agents, changes);
  showUpdates();
  if (tourPending) startTourWhenSettled();
}

function disconnected() {
  $('conn').className = 'conn down';
  $('updated').textContent = tr('Disconnected. Is the server running?');
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
  // Codex and OpenCode run the session in a background service: Stop
  // interrupts its turn there, then ends the app in its window, if that's known.
  $('confirm-what').textContent =
    a.app !== 'codex' && a.app !== 'opencode'
      ? tr("This force-ends PID {pid} along with its shells and MCP servers. Anything the current turn hasn't saved is lost.", { pid: a.pid })
      : a.pid
        ? a.app === 'codex'
          ? tr("This interrupts its current turn and ends Codex in its window, PID {pid}. What the turn hasn't finished is lost.", { pid: a.pid })
          : tr("This interrupts its current turn and ends OpenCode in its window, PID {pid}. What the turn hasn't finished is lost.", { pid: a.pid })
        : tr("This interrupts its current turn. What the turn hasn't finished is lost. Its window isn't known, so close that yourself.");
  $('confirm-resume').textContent = resumeCommand(a);
  dialog.returnValue = '';
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'stop') return;
    try {
      if (a.background) stoppedHere.add(a.id);
      const r = await post(a, 'stop');
      toast(r.windowLeft ? tr('Interrupted {name}. Close its window to end it.', { name: displayName(a) }) : tr('Stopped {name}', { name: displayName(a) }));
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
  return g ? el('span', { class: `group-dot g-${g.color}`, title: tr('Group: {group}', { group: g.name }) }) : null;
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
        title: repoPick ? tr('Use {folder}', { folder: node.path }) : tr('Open {app} in {folder}', { app: APPS[repoData.app] || APPS.claude, folder: node.path }),
        onclick: (e) => (repoPick ? pickRepo(node, e.currentTarget) : openRepo(node, e.currentTarget)),
      },
      el('span', { class: 'repo-name', text: node.name }),
      folderGroupDot(node),
      live
        ? el('span', { class: 'repo-live', title: trn(live, '{n} session running here', '{n} sessions running here') }, el('span', { class: 'dot' }), String(live))
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
  $('repos-tree').replaceChildren(list || el('p', { class: 'tree-empty', text: terms.length ? tr('No repos match.') : tr('No git repos found.') }));
}

async function loadRepos(refresh) {
  try {
    const res = await fetch(`/api/repos${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(tr("Couldn't list repos (HTTP {status})", { status: res.status }));
    repoData = await res.json();
    const excluded = repoData.excluded ? ` · ${tr('{n} hidden', { n: repoData.excluded })}` : '';
    $('repos-root').textContent = `${shortPath(repoData.root)} · ${trn(repoData.count, '{n} repo', '{n} repos')}${excluded}`;
    $('repos-root').title = excluded ? tr('Change what is hidden in Settings') : '';
    $('repos-command').textContent = repoData.command;
    // Claude or Codex, once Codex is installed; it's the setting in Settings.
    $('repos-app').hidden = !otherAppsInstalled();
    showInstalledChoices('repos-app');
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
    toast(tr('Opening {app} in {folder}', { app: APPS[repoData.app] || APPS.claude, folder: node.name }));
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
  $('repos-title').textContent = tr('Choose a folder');
  $('repos-foot').hidden = true;
  $('repos-pick-foot').hidden = false;
  $('repos-pick-foot').textContent = start ? tr('Click a repo to start “{title}” there.', { title: todo.title }) : tr('Click a repo to use it for “{title}”.', { title: todo.title });
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
  $('repos-title').textContent = tr('Repositories');
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
  if (days === 0) return tr('Today');
  if (days === 1) return tr('Yesterday');
  return d.toLocaleDateString(lang, { weekday: 'long', month: 'short', day: 'numeric' });
}

async function resumePast(s, button) {
  button.disabled = true;
  try {
    await api(`/api/history/${s.id}/resume`);
    $('history').close();
    toast(tr('Resuming {name}', { name: pastName(s) }));
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
  if (s.prompts) meta.push(trn(s.prompts, '{n} prompt', '{n} prompts'));
  if (s.model) meta.push(modelLabel(s));
  return el(
    'li',
    { class: 'past' },
    el(
      'div',
      { class: 'past-head' },
      el('span', { class: 'past-name', text: name, title: name }),
      s.completedAt ? el('span', { class: 'tag complete', title: tr('Marked complete: {when}', { when: new Date(s.completedAt).toLocaleString(lang) }), text: `✓ ${tr('Completed')}` }) : null,
      groupTag(s),
      appTag(s),
      since(s.closedAt, true),
    ),
    subtitle ? el('p', { class: 'past-title', text: subtitle, title: subtitle }) : null,
    s.todo ? el('p', { class: 'past-title', title: todoText(s.todo) }, el('b', {}, `${tr('To-do')} · `), s.todo.title) : null,
    el(
      'div',
      { class: 'where' },
      el('span', { class: 'path', text: shortPath(s.cwd), title: s.cwd }),
      s.gitBranch ? el('span', { class: 'tag branch', title: tr('Git branch'), text: `⎇ ${s.gitBranch}` }) : null,
      s.background ? el('span', { class: 'tag background', title: tr('Ran in the background, with claude -p'), text: tr('Background') }) : null,
    ),
    ticketRow(s.tickets),
    s.lastPrompt ? el('p', { class: 'past-prompt', title: s.lastPrompt.text }, el('b', {}, `${tr('Last prompt')} · `), s.lastPrompt.text) : null,
    el(
      'div',
      { class: 'past-actions' },
      snap?.terminals
        ? el(
            'button',
            { type: 'button', class: 'btn btn-primary', title: tr('Open a terminal tab in its folder and continue the conversation'), onclick: (e) => resumePast(s, e.currentTarget) },
            tr('Resume'),
          )
        : null,
      el(
        'button',
        {
          type: 'button',
          class: 'btn',
          onclick: async () => {
            await copy(resumeCommand(s));
            toast(tr('Resume command copied'));
          },
        },
        tr('Copy resume command'),
      ),
      meta.length ? el('span', { class: 'past-meta', text: meta.join(' · ') }) : null,
    ),
  );
}

// Every word must appear somewhere in the session's names, folder, branch,
// prompts or tickets.
function renderHistory() {
  if (!historyData) return;
  const terms = $('history-filter').value.toLowerCase().split(/\s+/).filter(Boolean);
  const background = $('history-background').checked;
  const complete = $('history-complete').checked;
  const shown = historyData.filter((s) => {
    if (s.background && !background) return false;
    if (s.completedAt && !complete) return false;
    const tickets = (s.tickets || []).flatMap((t) => [t.key, t.title]);
    const text = [pastName(s), s.title, s.name, s.cwd, s.gitBranch, s.firstPrompt?.text, s.lastPrompt?.text, s.todo?.title, s.todo?.notes, ...tickets]
      .join(' ')
      .toLowerCase();
    return terms.every((t) => text.includes(t));
  });
  const n = historyData.length;
  const done = historyData.filter((s) => s.completedAt).length;
  $('history-sub').textContent = [
    trn(n, '{n} closed session', '{n} closed sessions'),
    done ? tr('Complete: {n}', { n: done }) : null,
    shown.length < n ? tr('{n} shown', { n: shown.length }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // The switches for background runs and complete sessions only show once there are some.
  $('history-background-label').hidden = !historyData.some((s) => s.background);
  $('history-complete-label').hidden = !done;
  const days = [];
  for (const s of shown) {
    const day = dayLabel(s.closedAt);
    if (days.at(-1)?.day !== day) days.push({ day, sessions: [] });
    days.at(-1).sessions.push(s);
  }
  $('history-list').replaceChildren(
    ...(days.length
      ? days.flatMap((d) => [el('h3', { class: 'history-day', text: d.day }), el('ul', {}, d.sessions.map(pastItem))])
      : [el('p', { class: 'tree-empty', text: n ? tr('No closed sessions match.') : tr('No sessions have closed in the last 30 days.') })]),
  );
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history', { cache: 'no-store' });
    if (!res.ok) throw new Error(tr("Couldn't load the history (HTTP {status})", { status: res.status }));
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
// Whether History lists sessions marked complete. Kept in this browser.
const HISTORY_COMPLETE_KEY = 'tabherd:history-complete';
try {
  $('history-complete').checked = localStorage.getItem(HISTORY_COMPLETE_KEY) !== 'off';
} catch {}
$('history-complete').addEventListener('change', (e) => {
  try {
    localStorage.setItem(HISTORY_COMPLETE_KEY, e.currentTarget.checked ? 'on' : 'off');
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

// The page's language, from those there's a table for. Automatic follows the
// browser's. Changing it reloads the page, which is translated as it loads,
// and opens Settings again.
const languageSelect = $('language');
languageSelect.replaceChildren(
  el('option', { value: 'auto', text: tr('Automatic ({language})', { language: LANGUAGES[browserLanguage] }) }),
  ...Object.entries(LANGUAGES).map(([value, text]) => el('option', { value, text, lang: value })),
);
languageSelect.value = languageChoice in LANGUAGES ? languageChoice : 'auto';
languageSelect.addEventListener('change', (e) => {
  try {
    localStorage.setItem(LANGUAGE_KEY, e.currentTarget.value);
    sessionStorage.setItem(LANGUAGE_KEY, 'changed');
  } catch {}
  location.reload();
});

// Fit lets each card grow to its content; the others make every card the same size.
radioSetting('card-size', ['fit', 'small', 'medium', 'large'], (size) => {
  list.dataset.size = size;
  list.classList.toggle('uniform', size !== 'fit');
});

// In the desktop app, the window can stay on top of other windows, from
// Settings or the pin in the header, and on Windows its background can be
// see-through. The app gives the page tabherdApp to say so. Both are kept in
// this browser, the app's own, and put back as the page loads.
const desktopApp = window.tabherdApp || null;
const ON_TOP_KEY = 'tabherd:on-top';
const SEE_THROUGH_KEY = 'tabherd:see-through';
let onTop = false;
let seeThrough = 0;
try {
  onTop = localStorage.getItem(ON_TOP_KEY) === 'on';
  seeThrough = Math.max(0, Math.min(80, Number(localStorage.getItem(SEE_THROUGH_KEY)) || 0));
} catch {}

async function keepOnTop(on) {
  try {
    await desktopApp.setOnTop(on);
    onTop = on;
    try {
      localStorage.setItem(ON_TOP_KEY, on ? 'on' : 'off');
    } catch {}
  } catch (err) {
    toast(tr("Couldn't change that: {error}", { error: err }), true);
  }
  $('on-top').checked = onTop;
  $('pin-button').setAttribute('aria-pressed', String(onTop));
  $('pin-button').title = onTop ? tr('On top of other windows: click to stop') : tr('Keep this window on top of other windows');
}

// A percentage of the background that lets what's behind show through; 0 is off.
function showSeeThrough() {
  document.documentElement.classList.toggle('see-through', seeThrough > 0);
  document.documentElement.style.setProperty('--see-through', `${seeThrough}%`);
  $('see-through').value = String(seeThrough);
  $('see-through-value').textContent = seeThrough ? `${seeThrough}%` : tr('Off');
}

if (desktopApp) {
  $('window-setting').hidden = false;
  $('pin-button').hidden = false;
  $('pin-button').addEventListener('click', () => keepOnTop(!onTop));
  $('on-top').addEventListener('change', (e) => keepOnTop(e.currentTarget.checked));
  keepOnTop(onTop);
  if (desktopApp.seeThrough) {
    $('see-through-setting').hidden = false;
    $('see-through').addEventListener('input', (e) => {
      seeThrough = Number(e.currentTarget.value);
      try {
        localStorage.setItem(SEE_THROUGH_KEY, String(seeThrough));
      } catch {}
      showSeeThrough();
    });
    showSeeThrough();
  }
}

// In the desktop app the header stands in for the window's title bar. On
// Windows and Linux it has the window's buttons; on macOS it leaves room for
// the system's, in its top left corner. The cards scroll below it, rather
// than the whole page, so the scroll bar doesn't run up beside the buttons.
const cardScroller = () => (desktopApp?.titleBar ? document.querySelector('main') : document.scrollingElement);
if (desktopApp?.titleBar) {
  document.documentElement.dataset.titleBar = desktopApp.titleBar;
  if (desktopApp.titleBar === 'buttons') {
    $('window-buttons').hidden = false;
    $('window-minimize').addEventListener('click', () => desktopApp.minimize());
    $('window-maximize').addEventListener('click', () => desktopApp.toggleMaximize());
    $('window-close').addEventListener('click', () => desktopApp.close());
    // Maximize turns into Restore while the window is maximized.
    const showMaximized = async () => {
      const maximized = await desktopApp.isMaximized().catch(() => false);
      const label = maximized ? tr('Restore') : tr('Maximize');
      $('window-maximize').classList.toggle('maximized', maximized);
      $('window-maximize').title = label;
      $('window-maximize').setAttribute('aria-label', label);
    };
    addEventListener('resize', showMaximized);
    showMaximized();
  }
}

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
    title: hiddenBy ? tr('Hidden along with {folder}', { folder: showRepoPath(hiddenBy) }) : null,
    'aria-label': tr('Show {folder} in the repo menu', { folder: label }),
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
  const count = !hidden ? String(total) : hidden === total ? tr('{n} hidden', { n: total }) : tr('{hidden} of {total} hidden', { hidden, total });
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
    tree.replaceChildren(el('p', { class: 'tree-empty', text: tr('Loading…') }));
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
      el('p', { class: 'tree-empty', text: terms.length ? tr('No folders or repos match.') : tr('No git repos found.') }),
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
            title: tr('Stop hiding it'),
            'aria-label': tr('Stop hiding {folder}', { folder: showRepoPath(p) }),
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
    if (!res.ok) throw new Error(tr("Couldn't load settings (HTTP {status})", { status: res.status }));
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
    el('option', { value: 'auto', text: tr('Automatic') }),
    ...terminalChoices.map((t) =>
      el('option', { value: t.id, text: t.available ? t.name : tr('{name} (not found)', { name: t.name }), disabled: !t.available && t.id !== current }),
    ),
  );
  select.value = current;
}

// The settings kept on the server, other than the repo menu's. The to-do
// folder box isn't changed under someone typing in it.
function renderServerSettings() {
  for (const [id, key] of APP_ADDRESSES) {
    if (document.activeElement !== $(id)) $(id).value = serverSettings?.[key] || '';
  }
  $('lmstudio-key').placeholder = serverSettings?.lmstudioKeySet ? tr('Set. Type a new one to change it') : tr('None');
  const key = $('localai-key');
  key.placeholder = serverSettings?.localaiKeySet ? tr('Set. Type a new one to change it') : tr('None');
  $('app-setting').hidden = !otherAppsInstalled();
  showInstalledChoices('new-app');
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
for (const [id, key] of APP_ADDRESSES) {
  $(id).addEventListener('change', (e) => saveServerSetting({ [key]: e.currentTarget.value }));
  $(id).addEventListener('keydown', noSubmit((input) => input.blur()));
}
$('lmstudio-key').addEventListener('change', async (e) => {
  const input = e.currentTarget;
  if (await saveServerSetting({ lmstudioKey: input.value })) input.value = '';
});
$('lmstudio-key').addEventListener('keydown', noSubmit((input) => input.blur()));
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
    button.textContent = tr('{label}?', { label: tr('Delete') });
    setTimeout(() => {
      button.classList.remove('btn-danger');
      button.textContent = tr('Delete');
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
        'aria-label': tr('Group name'),
        'data-focus': `name:${g.id}`,
        onchange: (e) => {
          const name = e.currentTarget.value.trim();
          if (name) changeGroup(g, { name });
          else {
            e.currentTarget.value = g.name;
            toast(tr('A group needs a name.'), true);
          }
        },
        onkeydown: noSubmit((input) => input.blur()),
      }),
      el('button', { type: 'button', class: 'btn btn-stop', onclick: (e) => deleteGroup(g, e.currentTarget) }, tr('Delete')),
    ),
    el(
      'div',
      { class: 'swatches', role: 'radiogroup', 'aria-label': tr("{group}'s colour", { group: g.name }) },
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
              el(
                'button',
                { type: 'button', class: 'icon-btn', title: tr('Remove'), 'aria-label': tr('Remove {folder}', { folder: shortPath(f) }), onclick: () => changeGroup(g, { folders: g.folders.filter((x) => x !== f) }) },
                '✕',
              ),
            ),
          ),
        )
      : el('p', { class: 'settings-help', text: tr('No folders yet, so only sessions moved here by hand are in it.') }),
    el(
      'div',
      { class: 'group-add-folder' },
      el('input', {
        type: 'text',
        list: 'group-folders',
        placeholder: tr('Add a folder: a full path, or pick a repo'),
        'aria-label': tr('Add a folder to {group}', { group: g.name }),
        autocomplete: 'off',
        spellcheck: 'false',
        'data-focus': `add:${g.id}`,
        onkeydown: noSubmit((input) => addGroupFolder(g, input)),
      }),
      el('button', { type: 'button', class: 'btn', onclick: (e) => addGroupFolder(g, e.currentTarget.previousElementSibling) }, tr('Add')),
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
  const g = { id: crypto.randomUUID(), name: tr('Group {n}', { n: groups.length + 1 }), color: freeColor(groups), folders: [] };
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

// Settings shows one section at a time, picked from the list down its left
// side. It opens at the last one used, kept in this browser.
const SETTINGS_SECTION_KEY = 'tabherd:settings-section';

function showSettingsSection(id, focus) {
  const sections = [...document.querySelectorAll('.settings-section')];
  const shown = sections.find((s) => s.id === id) || sections[0];
  for (const s of sections) s.hidden = s !== shown;
  for (const b of $('settings-nav').children) {
    const on = b.dataset.section === shown.id;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  $('settings').querySelector('.settings-panels').scrollTop = 0;
  try {
    localStorage.setItem(SETTINGS_SECTION_KEY, shown.id);
  } catch {}
}

$('settings-nav').replaceChildren(
  ...[...document.querySelectorAll('.settings-section')].map((s) =>
    el('button', { type: 'button', role: 'tab', 'data-section': s.id, 'aria-controls': s.id, onclick: () => showSettingsSection(s.id) }, s.dataset.title),
  ),
);
// Up and down arrows move through the list, as in other tab lists.
$('settings-nav').addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault();
  const tabs = [...$('settings-nav').children];
  const i = tabs.indexOf(document.activeElement);
  const next = tabs[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  showSettingsSection(next.dataset.section, true);
});

// Opens Settings, at the section holding `elementId` if given.
// ---- Settings → Tickets ------------------------------------------------------

// The ticket trackers, without their tokens, and how secrets are kept on this
// computer. Loaded each time Settings opens.
let trackerData = null;
// What each tracker's last Test said, by its ID.
const trackerTests = new Map();
let editingTracker = null;

const TRACKER_TYPES = { jira: 'Jira', linear: 'Linear', github: 'GitHub Issues', zendesk: 'Zendesk' };
// What each type needs, and where its token comes from.
const TRACKER_HELP = {
  jira: tr(
    "Address: your Jira site. Token: an API token from id.atlassian.com → Security → API tokens, for the email you sign in with. Leave the email empty for a Jira Data Center personal access token. Key prefixes are your projects' keys, to look up only those here; leave them empty to try any key.",
  ),
  linear: tr("Token: a personal API key, from Linear → Settings → Security & access. Key prefixes are your teams' keys; leave them empty to try any key."),
  github: tr("Uses gh's own sign-in, so no token is kept here. If Test says so, run gh auth login."),
  zendesk: tr(
    'Address: your Zendesk, such as https://example.zendesk.com. An API token is made in Admin Center → Apps and integrations → Zendesk API. Zendesk is replacing API tokens with OAuth access tokens, which work here too. A key prefix, such as ZD, finds ZD-1234 in branch names.',
  ),
};
const TRACKER_ADDRESSES = { jira: 'https://example.atlassian.net', zendesk: 'https://example.zendesk.com' };
const SECRETS_KEPT = {
  dpapi: tr('Tokens and trackers are saved encrypted, with a key Windows keeps for your user.'),
  keychain: tr('Tokens and trackers are saved encrypted, with a key kept in your login Keychain.'),
  'secret-service': tr('Tokens and trackers are saved encrypted, with a key kept in your keyring.'),
  file: tr('Tokens and trackers are saved encrypted, with a key in ~/.tabherd/secret.key that only you can read. A keyring, such as GNOME Keyring or KWallet, would keep it safer.'),
};

async function loadTrackers() {
  try {
    trackerData = await api('/api/tickets/trackers/list');
    renderTrackers();
  } catch (err) {
    $('tracker-protection').textContent = err.message;
  }
}

function renderTrackers() {
  if (!trackerData) return;
  $('tracker-list').replaceChildren(
    ...trackerData.trackers.map((t) => {
      const tested = trackerTests.get(t.id);
      const about = [TRACKER_TYPES[t.type], t.url.replace(/^https?:\/\//, ''), t.prefixes.join(', ')].filter(Boolean).join(' · ');
      let note = null;
      if (tested?.pending) note = el('span', { text: tr('Testing…') });
      else if (tested) note = el('span', { class: tested.ok ? 'tracker-ok' : 'tracker-error', text: tested.ok ? tr('Connected as {name}', { name: tested.as }) : tested.error });
      else if (t.type !== 'github' && !t.tokenSet) note = el('span', { class: 'tracker-error', text: tr('No token yet') });
      // Its tickets keep their last known status until it answers again.
      else if (trackerData.problems?.[t.id]) note = el('span', { class: 'tracker-error', text: tr('Looking up tickets: {problem}', { problem: tr(trackerData.problems[t.id].error) }) });
      return el(
        'li',
        { class: 'filter-row tracker-row' },
        el('div', { class: 'filter-row-text' }, el('b', { text: t.name }), el('span', { text: about, title: about }), note),
        el('button', { type: 'button', class: 'btn', disabled: Boolean(tested?.pending), onclick: () => testTracker(t.id) }, tr('Test')),
        el('button', { type: 'button', class: 'btn', onclick: () => openTrackerDialog(t) }, tr('Edit')),
        el('button', { type: 'button', class: `btn btn-stop ${armedClass(`tracker:${t.id}`)}`, 'data-armed': `tracker:${t.id}`, onclick: (e) => removeTracker(t, e.currentTarget) }, armedLabel(`tracker:${t.id}`, tr('Remove'))),
      );
    }),
  );
  const s = trackerData.secrets;
  const notes = [s.state === 'failed' ? tr("Secrets can't be saved on this computer: {problem}", { problem: tr(s.problem) }) : SECRETS_KEPT[s.protection] || tr('Tokens and trackers are saved encrypted.')];
  if (s.unreadable?.length) notes.push(tr('Some were encrypted by another user or on another computer, so they count as unset here. Enter them again.'));
  $('tracker-protection').textContent = notes.join(' ');
}

async function testTracker(id) {
  trackerTests.set(id, { pending: true });
  renderTrackers();
  try {
    const r = await api('/api/tickets/trackers/test', { id });
    trackerTests.set(id, { ok: true, as: r.as });
  } catch (err) {
    trackerTests.set(id, { ok: false, error: err.message });
  }
  renderTrackers();
}

async function removeTracker(t, button) {
  if (!secondClick(`tracker:${t.id}`, button, tr('Remove'))) return;
  try {
    trackerData = await api('/api/tickets/trackers/remove', { id: t.id });
    trackerTests.delete(t.id);
    renderTrackers();
  } catch (err) {
    toast(err.message, true);
  }
}

function openTrackerDialog(t = null) {
  editingTracker = t;
  $('tracker-dialog-title').textContent = t ? tr('Edit tracker') : tr('New tracker');
  $('tracker-save').textContent = t ? tr('Save') : tr('Add tracker');
  // A tracker's type is fixed once it's made.
  $('tracker-type').value = t?.type || 'jira';
  $('tracker-type').disabled = Boolean(t);
  $('tracker-name').value = t?.name || '';
  $('tracker-url').value = t?.url || '';
  $('tracker-email').value = t?.email || '';
  $('tracker-auth').value = t?.auth || 'token';
  $('tracker-token').value = '';
  $('tracker-prefixes').value = (t?.prefixes || []).join(', ');
  showTrackerFields();
  $('tracker-dialog').showModal();
  $('tracker-name').focus();
}

// Only the fields the chosen type uses.
function showTrackerFields() {
  const type = $('tracker-type').value;
  const signsIn = type === 'jira' || type === 'zendesk';
  $('tracker-url-field').hidden = !signsIn;
  $('tracker-url').placeholder = TRACKER_ADDRESSES[type] || '';
  $('tracker-auth-field').hidden = type !== 'zendesk';
  $('tracker-email-field').hidden = !(type === 'jira' || (type === 'zendesk' && $('tracker-auth').value === 'token'));
  $('tracker-token-field').hidden = type === 'github';
  $('tracker-token').placeholder = editingTracker?.tokenSet ? tr('Set. Type a new one to change it') : '';
  $('tracker-prefixes-field').hidden = type === 'github';
  $('tracker-help').textContent = TRACKER_HELP[type];
}
$('tracker-type').addEventListener('change', showTrackerFields);
$('tracker-auth').addEventListener('change', showTrackerFields);
$('tracker-add').addEventListener('click', () => openTrackerDialog());
for (const id of ['tracker-cancel', 'tracker-close']) $(id).addEventListener('click', () => $('tracker-dialog').close());

$('tracker-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('tracker-token').value.trim();
  const tracker = {
    id: editingTracker?.id,
    type: $('tracker-type').value,
    name: $('tracker-name').value,
    url: $('tracker-url').value,
    email: $('tracker-email').value,
    auth: $('tracker-auth').value,
    prefixes: $('tracker-prefixes').value.split(/[\s,]+/).filter(Boolean),
    // Left empty while editing, the saved token is kept.
    ...(token || !editingTracker ? { token } : {}),
  };
  const button = $('tracker-save');
  button.disabled = true;
  try {
    trackerData = await api('/api/tickets/trackers/save', { tracker });
    $('tracker-dialog').close();
    // A new or changed sign-in is tried straight away.
    testTracker(trackerData.id);
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
});

function openSettings(elementId) {
  $('settings').showModal();
  groupsDraft = null;
  renderGroupEditor();
  renderFilterSettings();
  loadTrackers();
  let section = elementId ? $(elementId)?.closest('.settings-section')?.id : null;
  if (!section) {
    try {
      section = localStorage.getItem(SETTINGS_SECTION_KEY);
    } catch {}
  }
  showSettingsSection(section, true);
  renderUpdateSetting();
  loadServerSettings();
  loadRepos(false);
}

// ---- first-run tour ----------------------------------------------------------

// A short look around the dashboard, on a browser's first visit and from
// Settings → Help. While it runs the page is frozen: the cards don't update,
// nothing scrolls, and only the tour can be clicked, so nothing moves under
// it. A first visit's tour waits until every session is on the page, so none
// look lost.
const TOUR_KEY = 'tabherd:tour';
let tourOn = false;
let tourPending = firstVisit;
let tourSteps = [];
let tourAt = 0;
let tourCard = null;
let tourSample = null;

const sessionCount = () => (snap?.agents || []).filter((a) => !isItem(a) && a.kind !== 'model').length;
const tourAll = (selector) => () => [...document.querySelectorAll(selector)];

const TOUR_STEPS = [
  {
    title: tr('Welcome to Tabherd'),
    text: () => {
      const n = sessionCount();
      const yours = n ? ` ${trn(n, 'The one running now is on the page.', 'The {n} running now are on the page.')}` : '';
      return `${tr('Every Claude Code, Codex and Copilot session on this computer gets a card here, and a ding when it needs you.')}${yours} ${tr(
        'This is a quick look around: nothing on the page changes while it runs, and your sessions carry on as usual.',
      )}`;
    },
  },
  {
    target: () => [tourCard],
    title: tr('A card for each session'),
    text: () =>
      tr(
        "Its status, Needs you, Working or Idle, and for how long; what it's doing; its last prompt and reply; and its model and tokens. Go to window brings up its terminal tab, and Catch up asks it where things stand.",
      ) + (tourSample ? ` ${tr('This one is only an example, and goes when the tour ends.')}` : ''),
  },
  {
    target: tourAll('#list .memory-card'),
    title: tr('Memory and models'),
    text: tr(
      'Memory in use, on the computer and each graphics card, and the models loaded in ComfyUI, LocalAI, Ollama, LM Studio or llama.cpp, with Unload where it can. Settings → Appearance turns it off.',
    ),
  },
  {
    target: tourAll('#filters'),
    title: tr('Filters'),
    text: tr('All, then filters of your own. Each tab counts its cards, in amber when one needs you. The ⋯ at the end makes a new filter or changes the one shown.'),
  },
  {
    target: tourAll('.view-filters > :not([hidden])'),
    title: tr('Apps and groups'),
    text: tr("Show only one app's sessions, or one group's. The counts on the tabs follow them."),
  },
  {
    target: tourAll('#menu-button'),
    title: tr('Your repos'),
    text: tr('Every repo in your repos folder. Pick one to start a session in it, in a new terminal tab.'),
  },
  {
    target: tourAll('#todo-new'),
    title: tr('To-dos'),
    text: tr("Note a task to start later. Its card's Start opens a session for it in its folder, named after it."),
  },
  {
    target: tourAll('#sessions-button, #history-button'),
    title: tr('Save and close, and History'),
    text: tr('Save and close every session at once, then resume them all later. History lists the sessions closed in the last 30 days, each with Resume.'),
  },
  {
    target: tourAll('#notes-button, #sound'),
    title: tr('Notifications and sound'),
    text: tr(
      "A ding when a session needs you or finishes, and a list of what happened while you were away. Browsers only play sound once you've clicked the page, so the bell may ask for a click.",
    ),
  },
  {
    target: tourAll('#settings-button'),
    title: tr('Settings'),
    text: tr('Theme, card size, groups, filters, the app and terminal new sessions open in, and more. This tour is in Settings → Help whenever you want it again.'),
  },
];

// The first session card on the page, or else an example one, put in for the
// tour and taken out after.
function tourSessionCard() {
  const sessions = new Set((snap?.agents || []).filter((a) => !isItem(a) && a.kind !== 'model').map((a) => a.id));
  const shown = [...list.children].find((n) => sessions.has(n.dataset.id));
  if (shown) return shown;
  const t = now();
  const sep = snap?.platform === 'win32' ? '\\' : '/';
  tourSample = card({
    app: 'claude',
    id: 'tour-example',
    pid: 18244,
    name: 'my-app',
    title: tr('Add a sign-up page'),
    cwd: [snap?.home || '', 'projects', 'my-app'].join(sep),
    gitBranch: 'main',
    status: 'busy',
    statusSince: t - 95e3,
    startedAt: t - 42 * 60e3,
    tools: [{ name: 'Bash', detail: 'npm test', at: t - 8e3 }],
    lastReply: { text: tr('The form and its checks are in. Running the tests now.'), at: t - 20e3 },
    lastPrompt: { text: tr('Add a sign-up page with email and password, and tests for it.'), at: t - 6 * 60e3 },
    model: 'claude-sonnet-5-5',
    contextTokens: 61000,
    contextLimit: 200000,
    outputTokens: 18400,
    prompts: 3,
  });
  tourSample.classList.add('tour-sample');
  tourSample.removeAttribute('data-id');
  // After the memory card, if it's there.
  const memory = list.querySelector('.memory-card');
  if (memory) memory.after(tourSample);
  else list.prepend(tourSample);
  $('empty').hidden = true;
  return tourSample;
}

// What a step points at, as one box on screen, or null if it's not showing.
function tourRect(step) {
  if (!step.target) return null;
  const rects = step
    .target()
    .filter(Boolean)
    .map((n) => n.getBoundingClientRect())
    .filter((r) => r.width && r.height);
  if (!rects.length) return null;
  const left = Math.max(0, Math.min(...rects.map((r) => r.left)));
  const top = Math.max(0, Math.min(...rects.map((r) => r.top)));
  const right = Math.min(innerWidth, Math.max(...rects.map((r) => r.right)));
  const bottom = Math.min(innerHeight, Math.max(...rects.map((r) => r.bottom)));
  return right > left && bottom > top ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
}

// Lights up what the step is about, with the panel beside it where there's
// room: below, above, to the right or left, else at the bottom of the screen.
function placeTour() {
  const r = tourRect(tourSteps[tourAt]);
  const spot = $('tour-spot');
  const panel = $('tour-panel');
  const pad = 6;
  const gap = 12;
  const edge = 12;
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;
  const x = (v) => Math.max(edge, Math.min(innerWidth - pw - edge, v));
  const y = (v) => Math.max(edge, Math.min(innerHeight - ph - edge, v));
  $('tour').classList.toggle('no-spot', !r);
  let left = (innerWidth - pw) / 2;
  let top = (innerHeight - ph) / 2;
  if (r) {
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const middle = r.left + r.width / 2 - pw / 2;
    if (r.bottom + pad + gap + ph <= innerHeight - edge) [left, top] = [x(middle), r.bottom + pad + gap];
    else if (r.top - pad - gap - ph >= edge) [left, top] = [x(middle), r.top - pad - gap - ph];
    else if (r.right + pad + gap + pw <= innerWidth - edge) [left, top] = [r.right + pad + gap, y(r.top)];
    else if (r.left - pad - gap - pw >= edge) [left, top] = [r.left - pad - gap - pw, y(r.top)];
    else [left, top] = [x((innerWidth - pw) / 2), innerHeight - ph - edge];
  }
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function showTourStep(i) {
  tourAt = i;
  const step = tourSteps[i];
  const last = i === tourSteps.length - 1;
  $('tour-step').textContent = tr('{n} of {total}', { n: i + 1, total: tourSteps.length });
  $('tour-title').textContent = step.title;
  $('tour-text').textContent = typeof step.text === 'function' ? step.text() : step.text;
  $('tour-back').hidden = i === 0;
  $('tour-next').textContent = i === 0 ? tr('Show me around') : last ? tr('Done') : tr('Next');
  $('tour-skip').hidden = last;
  // A card it points at is brought into view below the header, which stays put.
  const first = step.target?.().find(Boolean);
  if (first && !first.closest('.top')) {
    const r = first.getBoundingClientRect();
    const below = document.querySelector('.top').getBoundingClientRect().bottom + 12;
    if (r.top < below || r.top > innerHeight / 2) cardScroller().scrollBy(0, r.top - below);
  }
  placeTour();
  $('tour-next').focus();
}

function startTour() {
  if (tourOn || !snap) return;
  tourPending = false;
  // Brought up to date, then frozen.
  render();
  tourOn = true;
  // The update question waits, so the cards don't move under the tour.
  $('update-ask').hidden = true;
  cardScroller().scrollTo(0, 0);
  tourCard = tourSessionCard();
  tourSteps = TOUR_STEPS.filter((s) => !s.target || tourRect(s));
  $('tour').showModal();
  showTourStep(0);
  try {
    localStorage.setItem(TOUR_KEY, 'seen');
  } catch {}
}

// A first visit's tour starts once the sessions have all arrived: Codex's are
// known, and the same cards came in two updates running. It waits for any
// dialog that's open to close.
let tourIds = null;
let tourWaitFrom = 0;

function startTourWhenSettled() {
  const ids = [...snap.agents.map((a) => a.id), ...(snap.todos || []).map((t) => t.id)].sort().join();
  const steady = ids === tourIds && snap.settled !== false;
  tourIds = ids;
  tourWaitFrom ||= Date.now();
  if ((steady || Date.now() - tourWaitFrom > 15000) && !document.querySelector('dialog[open]')) startTour();
}

$('tour-next').addEventListener('click', () => (tourAt === tourSteps.length - 1 ? $('tour').close() : showTourStep(tourAt + 1)));
$('tour-back').addEventListener('click', () => tourAt > 0 && showTourStep(tourAt - 1));
$('tour-skip').addEventListener('click', () => $('tour').close());
// Esc closes it too, as it does any dialog. The arrow keys move through it,
// and nothing else scrolls the page under it.
$('tour').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' && tourAt < tourSteps.length - 1) showTourStep(tourAt + 1);
  else if (e.key === 'ArrowLeft' && tourAt > 0) showTourStep(tourAt - 1);
  else if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
});
for (const type of ['wheel', 'touchmove']) $('tour').addEventListener(type, (e) => e.preventDefault(), { passive: false });
addEventListener('resize', () => tourOn && placeTour());
$('tour').addEventListener('close', () => {
  tourOn = false;
  tourSample?.remove();
  tourSample = null;
  tourCard = null;
  render();
});
$('tour-again').addEventListener('click', () => {
  $('settings').close();
  startTour();
});

// ---- start ---------------------------------------------------------------------

$('settings-button').addEventListener('click', () => openSettings());
$('settings').addEventListener('click', (e) => e.target === e.currentTarget && e.currentTarget.close());
renderNotes();
// Starting a to-do needs the folder setting before Settings is ever opened.
loadServerSettings();
// Back from choosing a language, Settings opens again where it was.
try {
  if (sessionStorage.getItem(LANGUAGE_KEY)) {
    sessionStorage.removeItem(LANGUAGE_KEY);
    openSettings('language');
  }
} catch {}

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
