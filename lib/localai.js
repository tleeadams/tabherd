'use strict';

// LocalAI as cards: each model loaded in memory, each download or install in
// progress, each agent chat that's running, waiting on you, or finished in
// the last few minutes, and each agent job running or queued. LocalAI keeps no
// list of plain API requests in progress, so those don't show.
//
// It's found at Settings' LocalAI address, http://127.0.0.1:8080 unless set,
// and asked with Settings' API key if LocalAI has one set.

const REFRESH_MS = 2000;
const REQUEST_MS = 2500;
const INFO_REFRESH_MS = 60 * 1000;
// How long a finished chat or job keeps its card.
const RECENT_MS = 15 * 60 * 1000;
const DEFAULT_URL = 'http://127.0.0.1:8080';

let config = { url: DEFAULT_URL, key: '' };
let state = null;
let info = null;
let infoAt = 0;
let refreshing = null;
let refreshedAt = 0;
// When each download, and a refused key, was first seen, for how long it's
// been going.
const firstSeen = new Map();

function seenSince(id, now = Date.now()) {
  if (!firstSeen.has(id)) firstSeen.set(id, now);
  return firstSeen.get(id);
}

const headers = () => (config.key ? { Authorization: `Bearer ${config.key}` } : {});

async function request(route, { method = 'GET', body } = {}) {
  const res = await fetch(config.url.replace(/\/+$/, '') + route, {
    method,
    headers: { ...headers(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  if (!res.ok) {
    const err = new Error(res.status === 401 || res.status === 403 ? 'LocalAI wants an API key: set it in Settings.' : `LocalAI answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({}));
}

// What may be missing, such as chats when LocalAI has them turned off, is
// left out rather than failing the rest.
const optional = (p) => p.catch((err) => (err.status === 401 || err.status === 403 ? Promise.reject(err) : null));

async function refresh() {
  if (!info || Date.now() - infoAt > INFO_REFRESH_MS) {
    info = await request('/.well-known/localai.json');
    infoAt = Date.now();
  }
  const caps = info?.capabilities || {};
  const [system, operations, chats, jobs] = await Promise.all([
    request('/system'),
    optional(request('/api/operations')),
    caps.chats === false ? null : optional(request('/api/chats?limit=50')),
    // Version 4 calls the feature agents, version 5 agent_jobs.
    caps.agent_jobs || caps.agents ? optional(request('/api/agent/jobs?limit=20')) : null,
  ]);
  const ids = new Set((operations?.operations || []).map((o) => `op:${o.jobID || o.id}`));
  for (const id of firstSeen.keys()) if (!ids.has(id)) firstSeen.delete(id);
  state = {
    // Version 4 adds the commit after a space.
    version: typeof info?.version === 'string' ? info.version.split(' ')[0] : null,
    models: system?.loaded_models || [],
    operations: operations?.operations || [],
    chats: chats?.conversations || [],
    jobs: Array.isArray(jobs) ? jobs : jobs?.jobs || [],
    error: null,
  };
}

function poll() {
  if (refreshing || Date.now() - refreshedAt < REFRESH_MS) return;
  refreshing = refresh()
    .catch((err) => {
      // Not running is the usual case, and shows nothing. A refused key shows
      // once on a card, so it can be fixed.
      state = err.status === 401 || err.status === 403 ? { error: err.message, models: [], operations: [], chats: [], jobs: [] } : null;
      if (!state) info = null;
    })
    .finally(() => {
      refreshing = null;
      refreshedAt = Date.now();
    });
}

const ms = (t) => (typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : t ? Date.parse(t) : null);
const bytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : n ? `${n} B` : null);

// LocalAI's state as cards.
function itemsFrom(s, { url = DEFAULT_URL, now = Date.now() } = {}) {
  if (!s) return [];
  const base = url.replace(/\/+$/, '');
  const items = [];
  const card = (fields) => ({ app: 'localai', host: s.version ? `LocalAI ${s.version}` : 'LocalAI', url: `${base}/`, ...fields });
  if (s.error) {
    items.push(card({ kind: 'service', id: 'localai:service', name: 'LocalAI', status: 'waiting', waitingFor: s.error, statusSince: seenSince('service', now), actions: ['open'] }));
  }
  for (const m of s.models) {
    if (!m?.id) continue;
    items.push(
      card({
        kind: 'model',
        id: `localai:model:${m.id}`,
        model: m.id,
        name: m.id,
        where: m.backend || null,
        status: 'loaded',
        statusSince: ms(m.process?.started_at),
        startedAt: ms(m.process?.started_at),
        facts: [
          ['Graphics memory', bytes(m.size_vram)],
          ['Memory', bytes(m.process?.rss_bytes)],
          ['CPU', Number.isFinite(m.process?.cpu_percent) ? `${Math.round(m.process.cpu_percent)}%` : null],
        ].filter(([, v]) => v),
        actions: ['open', 'unload'],
      }),
    );
  }
  for (const o of s.operations) {
    if (!o?.jobID && !o?.id) continue;
    const what = o.isDeletion ? 'Removing' : o.isBackend ? 'Installing backend' : 'Downloading';
    items.push(
      card({
        kind: 'download',
        id: `localai:op:${o.jobID || o.id}`,
        jobId: o.jobID || o.id,
        name: o.name || o.fullName || 'Download',
        where: what,
        status: o.error ? 'waiting' : o.isQueued ? 'queued' : 'busy',
        statusLabel: o.error ? 'Failed' : o.isQueued ? 'Queued' : what,
        waitingFor: o.error ? `Failed: ${String(o.error).slice(0, 200)}` : o.needsApproval ? 'Waiting for approval in LocalAI' : null,
        statusSince: seenSince(`op:${o.jobID || o.id}`, now),
        progress: Number.isFinite(o.progress) ? { value: o.progress, max: 100 } : null,
        facts: [
          ['Size', o.totalBytes ? `${bytes(o.currentBytes || 0)} of ${bytes(o.totalBytes)}` : null],
          ['Now', o.message || o.phase || null],
        ].filter(([, v]) => v),
        // It leaves the list when it's done, which counts as finishing.
        leavesWhenDone: true,
        actions: o.cancellable ? ['open', 'cancel'] : ['open'],
      }),
    );
  }
  for (const c of s.chats) {
    if (!c?.id || c.kind === 'subagent') continue;
    const updated = ms(c.updated) || ms(c.created);
    const paused = c.last_turn === 'paused';
    const failed = c.last_turn === 'failed';
    if (!c.running && !paused && !(updated && now - updated < RECENT_MS)) continue;
    items.push(
      card({
        kind: 'chat',
        id: `localai:chat:${c.id}`,
        chatId: c.id,
        name: c.title || 'Chat',
        where: c.model || null,
        status: c.running ? 'busy' : paused || failed ? 'waiting' : 'idle',
        statusLabel: c.running ? null : paused ? null : failed ? 'Failed' : c.last_turn === 'interrupted' || c.last_turn === 'stopped' ? 'Stopped' : 'Done',
        waitingFor: paused ? 'Paused: reply to continue' : failed ? 'Its last turn failed' : null,
        statusSince: updated,
        startedAt: ms(c.created),
        actions: c.running ? ['open', 'stop'] : ['open'],
      }),
    );
  }
  for (const j of s.jobs) {
    if (!j?.id) continue;
    const ended = ms(j.completed_at);
    const active = j.status === 'running' || j.status === 'pending';
    if (!active && !(ended && now - ended < RECENT_MS)) continue;
    items.push(
      card({
        kind: 'agent-job',
        id: `localai:job:${j.id}`,
        jobId: j.id,
        name: j.task_name || j.task_id || 'Agent job',
        where: j.triggered_by ? `Started by ${j.triggered_by}` : null,
        status: j.status === 'running' ? 'busy' : j.status === 'pending' ? 'queued' : j.status === 'failed' ? 'waiting' : 'idle',
        statusLabel: j.status === 'completed' ? 'Done' : j.status === 'cancelled' ? 'Cancelled' : j.status === 'failed' ? 'Failed' : null,
        waitingFor: j.status === 'failed' ? `Failed${j.error ? `: ${String(j.error).slice(0, 200)}` : ''}` : null,
        statusSince: ended || ms(j.started_at) || ms(j.created_at),
        startedAt: ms(j.started_at) || ms(j.created_at),
        lastReply: typeof j.result === 'string' && j.result.trim() ? { text: j.result.replace(/\s+/g, ' ').slice(0, 600), at: j.completed_at } : null,
        actions: active ? ['open', 'cancel'] : ['open'],
      }),
    );
  }
  return items;
}

// Where LocalAI is, and its key, from Settings. A change starts afresh.
function configure({ url, key } = {}) {
  const next = { url: url || DEFAULT_URL, key: key || '' };
  if (next.url === config.url && next.key === config.key) return;
  config = next;
  state = null;
  info = null;
  refreshedAt = 0;
}

// LocalAI's cards from the last check, which checks again in the background.
function snapshot() {
  poll();
  if (!state?.error) firstSeen.delete('service');
  return itemsFrom(state, { url: config.url });
}

// Unload a model, stop a chat's turn, or cancel a download or agent job.
async function act(item, action) {
  try {
    if (action === 'unload' && item.kind === 'model') await request('/backend/shutdown', { method: 'POST', body: { model: item.model } });
    else if (action === 'stop' && item.kind === 'chat') await request(`/api/chats/${encodeURIComponent(item.chatId)}/stop`, { method: 'POST' });
    else if (action === 'cancel' && item.kind === 'download') await request(`/api/operations/${encodeURIComponent(item.jobId)}/cancel`, { method: 'POST' });
    else if (action === 'cancel' && item.kind === 'agent-job') await request(`/api/agent/jobs/${encodeURIComponent(item.jobId)}/cancel`, { method: 'POST' });
    else return { ok: false, error: "That can't be done here." };
    refreshedAt = 0;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { snapshot, configure, act, itemsFrom, DEFAULT_URL };
