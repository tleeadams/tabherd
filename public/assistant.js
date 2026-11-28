'use strict';

// The Config Assistant's page: each task the server says applies here, with
// its items, what each would change, and Apply and Undo.

const TOKEN = document.querySelector('meta[name="agents-token"]').content;

// The language and theme the dashboard's Settings chose, as the dashboard
// reads them (see app.js).
const LANGUAGES = { en: 'English', es: 'Español' };
let choice = 'auto';
let theme = 'system';
try {
  choice = localStorage.getItem('tabherd:language') || 'auto';
  theme = localStorage.getItem('tabherd:theme') || 'system';
} catch {}
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
const browserLanguage =
  (navigator.languages || [navigator.language]).map((l) => String(l).toLowerCase().split('-')[0]).find((l) => l in LANGUAGES) || 'en';
const lang = choice in LANGUAGES ? choice : browserLanguage;
const phrases = (lang !== 'en' && window.TABHERD_LANGUAGES?.[lang]) || {};
const fillIn = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text);
const tr = (text, vars) => fillIn(typeof phrases[text] === 'string' ? phrases[text] : text, vars);

function translatePage() {
  if (lang === 'en') return;
  document.documentElement.lang = lang;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement.closest('script, style, code') || !n.nodeValue.trim()) continue;
    n.nodeValue = n.nodeValue.replace(n.nodeValue.trim(), tr(n.nodeValue.trim()));
  }
  document.title = tr('Tabherd Config Assistant');
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter(Boolean));
  return node;
}

const STATES = { done: () => tr('Done'), needed: () => tr('Needed'), problem: () => tr('Needs a look') };
// The last outcome for each item, shown under it.
const notes = new Map();

function render(tasks) {
  const box = document.getElementById('tasks');
  if (!tasks.length) {
    box.replaceChildren(el('p', { class: 'empty', text: tr('Nothing to set up on this computer. Tasks show here once they apply, such as when VS Code and a second Claude account are both found.') }));
    return;
  }
  box.replaceChildren(
    ...tasks.map((t) =>
      el(
        'section',
        { class: 'task' },
        el('h2', { text: tr(t.title) }),
        el('p', { class: 'task-why', text: tr(t.why) }),
        ...t.items.map((i) => {
          const note = notes.get(`${t.id}:${i.key}`);
          return el(
            'div',
            { class: 'item' },
            el(
              'div',
              { class: 'item-head' },
              el('span', { class: 'item-name', text: i.label }),
              el('span', { class: `state state-${i.status}`, text: STATES[i.status]?.() || i.status }),
              el(
                'span',
                { class: 'item-buttons' },
                i.canUndo ? el('button', { type: 'button', class: 'btn', text: tr('Undo'), onclick: (e) => run(t.id, i.key, 'undo', e.currentTarget) }) : null,
                i.status !== 'done' && !i.problem
                  ? el('button', { type: 'button', class: 'btn btn-primary', text: tr('Apply'), onclick: (e) => run(t.id, i.key, 'apply', e.currentTarget) })
                  : null,
              ),
            ),
            el('div', { class: 'item-path', text: i.detail }),
            i.problem ? el('p', { class: 'item-problem', text: i.problem }) : null,
            el('ol', { class: 'steps' }, ...i.steps.map((s) => el('li', { class: s.done ? 'done' : null, text: s.label }))),
            note ? el('p', { class: `item-note${note.error ? ' error' : ''}`, text: note.text }) : null,
          );
        }),
      ),
    ),
  );
}

async function load() {
  try {
    const res = await fetch('/api/assistant', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render((await res.json()).tasks);
  } catch (err) {
    document.getElementById('tasks').replaceChildren(el('p', { class: 'item-problem', text: tr("Couldn't reach Tabherd: {error}", { error: err.message }) }));
  }
}

async function run(task, key, action, button) {
  for (const b of document.querySelectorAll('.item-buttons button')) b.disabled = true;
  button.textContent = action === 'undo' ? tr('Undoing…') : tr('Working…');
  let r;
  try {
    const res = await fetch('/api/assistant/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agents-Token': TOKEN },
      body: JSON.stringify({ task, key, action }),
    });
    r = await res.json();
  } catch (err) {
    r = { ok: false, error: err.message };
  }
  notes.set(`${task}:${key}`, r.ok ? { text: r.done || tr('Done.') } : { text: r.error || tr('That didn’t work.'), error: true });
  if (r.tasks) render(r.tasks);
  else load();
}

translatePage();
load();
