'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// A language's table, as the page loads it.
function table(code) {
  const window = {};
  vm.runInNewContext(read('public', 'lang', `${code}.js`), { window });
  return window.TABHERD_LANGUAGES[code];
}

// Every text app.js passes to tr() and trn() as it's written.
function scriptKeys(src) {
  const lit = String.raw`('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|` + '`' + String.raw`(?:\\.|[^` + '`' + String.raw`\\$])*` + '`)';
  const text = (s) => (s[0] === '`' ? s.slice(1, -1) : vm.runInNewContext(s));
  const keys = new Set();
  for (const m of src.matchAll(new RegExp(String.raw`\btr\(\s*` + lit, 'g'))) keys.add(text(m[1]));
  for (const m of src.matchAll(new RegExp(String.raw`\btrn\([^,]+,\s*` + lit + String.raw`\s*,\s*` + lit, 'g'))) {
    keys.add(text(m[1]));
    keys.add(text(m[2]));
  }
  return keys;
}

// Every text index.html has, as the page translates it: an element marked
// data-i18n whole, and elsewhere each piece of text outside code, and the
// titles, labels and placeholders.
function pageKeys(html) {
  const keys = new Set();
  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  let body = html.slice(html.indexOf('<body'));
  body = body.replace(/<(\w+)([^>]*\sdata-i18n[^>]*)>([\s\S]*?)<\/\1>/g, (m, tag, attrs, inner) => {
    keys.add(inner.replace(/\s+/g, ' ').trim());
    return `<${tag}${attrs}></${tag}>`;
  });
  body = body.replace(/<(script|style|code)\b[\s\S]*?<\/\1>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/>([^<]+)</g)) keys.add(decode(m[1].replace(/\s+/g, ' ').trim()));
  for (const m of body.matchAll(/\s(?:title|aria-label|placeholder|data-title|alt)="([^"]*)"/g)) keys.add(decode(m[1]));
  // Not words: symbols, counts and addresses.
  return new Set([...keys].filter((k) => /[A-Za-z]{2}/.test(k) && !/^https?:\/\//.test(k)));
}

// Names, which stay as they are in every language.
const NAMES = new Set(['Tabherd', 'Claude', 'Codex', 'Copilot', 'OpenCode', 'Cursor', 'Antigravity', 'auto']);

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s) => [...s.matchAll(/<[^>]+>/g)].map((m) => m[0]).sort();

test('every text the page shows has its Spanish', () => {
  const es = table('es');
  const used = [...scriptKeys(read('public', 'app.js')), ...pageKeys(read('public', 'index.html'))];
  const missing = used.filter((k) => !NAMES.has(k) && !(k in es));
  assert.deepEqual(missing, [], 'add these to public/lang/es.js');
});

test('every Spanish text is one the page or the server still uses', () => {
  const es = table('es');
  const used = new Set([...scriptKeys(read('public', 'app.js')), ...pageKeys(read('public', 'index.html'))]);
  // What the server sends, which the page looks up as it shows it.
  const server = [read('server.js'), ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => read('lib', f))].join('\n');
  const said = (k) => [`'${k}'`, `"${k}"`].some((q) => server.includes(q));
  const stale = Object.keys(es).filter((k) => !used.has(k) && !said(k));
  assert.deepEqual(stale, [], 'no longer used: take these out of public/lang/es.js');
});

test('each Spanish text keeps its {placeholders} and markup', () => {
  for (const [key, value] of Object.entries(table('es'))) {
    assert.equal(typeof value, 'string', key);
    assert.deepEqual(placeholders(value), placeholders(key), key);
    assert.deepEqual(tags(value), tags(key), key);
  }
});

test("the page reads each table it lists, and the server serves it", () => {
  const html = read('public', 'index.html');
  const server = read('server.js');
  const app = read('public', 'app.js');
  const listed = Object.keys(vm.runInNewContext(`(${app.match(/const LANGUAGES = (\{[^}]*\})/)[1]})`)).filter((l) => l !== 'en');
  for (const code of listed) {
    assert.ok(html.includes(`<script src="/lang/${code}.js"></script>`), `index.html loads lang/${code}.js`);
    assert.ok(server.includes(`'/lang/${code}.js'`), `server.js serves lang/${code}.js`);
    assert.ok(Object.keys(table(code)).length > 0, `lang/${code}.js has words`);
  }
});
