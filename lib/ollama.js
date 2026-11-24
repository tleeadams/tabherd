'use strict';

// Ollama's loaded models as cards, from /api/ps: each with the graphics
// memory it holds, its size and context, when Ollama will unload it, and
// Unload. Ollama shows downloads and requests in progress only to whoever
// started them, so those don't get cards.
//
// It's found at Settings' Ollama address, else OLLAMA_HOST, else
// http://127.0.0.1:11434.

const REFRESH_MS = 2000;
const REQUEST_MS = 2500;
const DEFAULT_URL = 'http://127.0.0.1:11434';

// OLLAMA_HOST can be host, host:port or a URL, and 0.0.0.0 means every
// address, this computer's included. As Ollama reads it, a host without a
// scheme is on port 11434 unless it says otherwise; a URL is on its scheme's
// usual port.
function fromEnv(host = process.env.OLLAMA_HOST) {
  if (!host) return null;
  const given = host.trim();
  const schemeless = !/^https?:\/\//.test(given);
  try {
    const u = new URL(schemeless ? `http://${given}` : given);
    if (u.hostname === '0.0.0.0' || u.hostname === '[::]') u.hostname = '127.0.0.1';
    if (schemeless && !u.port) u.port = '11434';
    return u.origin;
  } catch {
    return null;
  }
}

let url = fromEnv() || DEFAULT_URL;
let state = null;
let refreshing = null;
let refreshedAt = 0;

function configure({ url: next } = {}) {
  const u = (next || fromEnv() || DEFAULT_URL).replace(/\/+$/, '');
  if (u === url) return;
  url = u;
  state = null;
  refreshedAt = 0;
}

async function request(route, body) {
  const res = await fetch(url + route, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
  return res.json();
}

async function refresh() {
  const [version, ps] = await Promise.all([request('/api/version'), request('/api/ps')]);
  state = { version: version?.version || null, models: ps?.models || [] };
}

function poll() {
  if (refreshing || Date.now() - refreshedAt < REFRESH_MS) return;
  refreshing = refresh()
    // Not running is the usual case, and shows nothing.
    .catch(() => (state = null))
    .finally(() => {
      refreshing = null;
      refreshedAt = Date.now();
    });
}

const bytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : null);

// When it unloads: a time today, or none for a model kept loaded.
function unloads(expiresAt, now) {
  const t = Date.parse(expiresAt || '');
  if (!Number.isFinite(t) || t - now > 30 * 24 * 3600 * 1000) return 'Stays loaded';
  const mins = Math.max(0, Math.round((t - now) / 60000));
  return mins < 1 ? 'Within a minute' : `In ${mins} min`;
}

function itemsFrom(s, { now = Date.now() } = {}) {
  if (!s) return [];
  return s.models.map((m) => ({
    app: 'ollama',
    kind: 'model',
    id: `ollama:model:${m.name || m.model}`,
    model: m.name || m.model,
    name: m.name || m.model,
    host: s.version ? `Ollama ${s.version}` : 'Ollama',
    where: [m.details?.parameter_size, m.details?.quantization_level].filter(Boolean).join(' · ') || null,
    status: 'loaded',
    facts: [
      ['Graphics memory', bytes(m.size_vram) || (m.size_vram === 0 ? 'None, on the CPU' : null)],
      ['Size', bytes(m.size)],
      ['Context', Number.isFinite(m.context_length) ? `${m.context_length.toLocaleString('en')} tokens` : null],
      ['Unloads', unloads(m.expires_at, now)],
    ].filter(([, v]) => v),
    actions: ['unload'],
  }));
}

// Ollama's cards from the last check, which checks again in the background.
function snapshot() {
  poll();
  return itemsFrom(state);
}

// Unloads a model: a request that keeps it loaded for no time.
async function act(item, action) {
  if (action !== 'unload') return { ok: false, error: "That can't be done here." };
  try {
    await request('/api/generate', { model: item.model, keep_alive: 0 });
    refreshedAt = 0;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Couldn't unload it: ${err.message}` };
  }
}

module.exports = { snapshot, configure, act, itemsFrom, fromEnv, DEFAULT_URL };
