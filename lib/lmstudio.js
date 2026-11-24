'use strict';

// LM Studio's loaded models as cards, from its REST API (/api/v1/models):
// each loaded instance, with its size and context, and Unload. LM Studio's
// local server has to be on, in its Developer tab or with `lms server start`.
//
// It's found at Settings' LM Studio address, else the port LM Studio last
// served on, else http://127.0.0.1:1234, and asked with Settings' API token
// if LM Studio requires one.

const fs = require('fs');
const os = require('os');
const path = require('path');

const REFRESH_MS = 2000;
const REQUEST_MS = 2500;
const DEFAULT_URL = 'http://127.0.0.1:1234';

// The port LM Studio's server last ran on, from its own (undocumented) file.
function lastPort(home = os.homedir()) {
  try {
    const { port } = JSON.parse(fs.readFileSync(path.join(home, '.lmstudio', '.internal', 'http-server-config.json'), 'utf8'));
    return Number.isInteger(port) && port > 0 && port < 65536 ? `http://127.0.0.1:${port}` : null;
  } catch {
    return null;
  }
}

let config = { url: null, key: '' };
let state = null;
let refreshing = null;
let refreshedAt = 0;

const base = () => (config.url || lastPort() || DEFAULT_URL).replace(/\/+$/, '');

function configure({ url, key } = {}) {
  if ((url || null) === config.url && (key || '') === config.key) return;
  config = { url: url || null, key: key || '' };
  state = null;
  refreshedAt = 0;
}

async function request(route, body) {
  const res = await fetch(base() + route, {
    method: body ? 'POST' : 'GET',
    headers: { ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  if (!res.ok) {
    const err = new Error(res.status === 401 || res.status === 403 ? 'LM Studio wants an API token: set it in Settings.' : `LM Studio answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function refresh() {
  try {
    const v1 = await request('/api/v1/models');
    state = { models: v1?.models || [], v1: true };
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw err;
    // Before LM Studio 0.4 there was only v0, which says which models are
    // loaded but can't unload them.
    const v0 = await request('/api/v0/models');
    state = { models: (v0?.data || []).filter((m) => m.state === 'loaded').map((m) => ({ ...m, key: m.id, loaded_instances: [{ id: m.id, config: { context_length: m.loaded_context_length } }] })), v1: false };
  }
}

function poll() {
  if (refreshing || Date.now() - refreshedAt < REFRESH_MS) return;
  refreshing = refresh()
    .catch((err) => {
      // Not running is the usual case, and shows nothing; a refused token
      // shows once, on a card, so it can be fixed.
      state = err.status === 401 || err.status === 403 ? { error: err.message, models: [] } : null;
    })
    .finally(() => {
      refreshing = null;
      refreshedAt = Date.now();
    });
}

const bytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : null);

function itemsFrom(s, { now = Date.now() } = {}) {
  if (!s) return [];
  if (s.error) return [{ app: 'lmstudio', kind: 'service', id: 'lmstudio:service', name: 'LM Studio', host: 'LM Studio', status: 'waiting', waitingFor: s.error, statusSince: now, actions: [] }];
  const items = [];
  for (const m of s.models) {
    for (const inst of m.loaded_instances || []) {
      if (!inst?.id) continue;
      items.push({
        app: 'lmstudio',
        kind: 'model',
        id: `lmstudio:model:${inst.id}`,
        instanceId: inst.id,
        name: m.display_name || m.key || inst.id,
        host: 'LM Studio',
        where: [m.quantization?.name || m.quantization, m.type && m.type !== 'llm' ? m.type : null].filter((v) => typeof v === 'string' && v).join(' · ') || null,
        status: 'loaded',
        facts: [
          ['Size', bytes(m.size_bytes)],
          ['Context', Number.isFinite(inst.config?.context_length) ? `${inst.config.context_length.toLocaleString('en')} tokens` : null],
          ['Parallel', Number.isFinite(inst.config?.parallel) && inst.config.parallel > 1 ? String(inst.config.parallel) : null],
        ].filter(([, v]) => v),
        actions: s.v1 ? ['unload'] : [],
      });
    }
  }
  return items;
}

// LM Studio's cards from the last check, which checks again in the background.
function snapshot() {
  poll();
  return itemsFrom(state);
}

async function act(item, action) {
  if (action !== 'unload' || item.kind !== 'model') return { ok: false, error: "That can't be done here." };
  try {
    await request('/api/v1/models/unload', { instance_id: item.instanceId });
    refreshedAt = 0;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Couldn't unload it: ${err.message}` };
  }
}

module.exports = { snapshot, configure, act, itemsFrom, lastPort, DEFAULT_URL };
