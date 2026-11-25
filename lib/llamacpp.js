'use strict';

// llama.cpp's server, llama-server: the model it has loaded, as a row on the
// Memory and models card, with its size, context and how many requests it's
// answering. In router mode (started with --models-dir or --models-preset)
// it loads models as they're asked for, so each one loaded or loading gets a
// row, and Unload unloads it. A server started with one model keeps it until
// it's stopped, so that row has no Unload.
//
// It's found at Settings' llama.cpp address, else at LLAMA_ARG_HOST and
// LLAMA_ARG_PORT as llama-server reads them, else http://127.0.0.1:8080,
// llama-server's own default. LocalAI's default is the same port; each tells
// the other apart by what it answers.

const REFRESH_MS = 2000;
const REQUEST_MS = 2500;
const DEFAULT_URL = 'http://127.0.0.1:8080';

function fromEnv(env = process.env) {
  if (!env.LLAMA_ARG_HOST && !env.LLAMA_ARG_PORT) return null;
  let host = (env.LLAMA_ARG_HOST || '127.0.0.1').trim();
  if (host === '0.0.0.0' || host === '::') host = '127.0.0.1';
  const port = Number(env.LLAMA_ARG_PORT) || 8080;
  try {
    return new URL(`http://${host.includes(':') ? `[${host}]` : host}:${port}`).origin;
  } catch {
    return null;
  }
}

let url = fromEnv() || DEFAULT_URL;
let state = null;
let refreshing = null;
let refreshedAt = 0;
// Counts unloads, so a check begun before one doesn't put back what it removed.
let unloads = 0;

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
  if (!res.ok) throw new Error(`llama.cpp answered ${res.status}`);
  return res.json();
}

const busy = (slots) => (Array.isArray(slots) ? slots.filter((s) => s.is_processing).length : null);

// What the server has loaded. /props says which mode it's in; a server still
// loading its one model answers 503 until it's ready, and shows nothing yet.
async function refresh() {
  const begun = unloads;
  const props = await request('/props');
  if (props?.role === 'router') {
    const list = await request('/models');
    const shown = (list?.data || []).filter((m) => ['loaded', 'loading'].includes(m.status?.value));
    const slots = await Promise.all(
      shown.map((m) => (m.status.value === 'loaded' ? request(`/slots?model=${encodeURIComponent(m.id)}`).catch(() => null) : null)),
    );
    if (begun === unloads) state = { build: props.build_info || null, router: true, models: shown.map((m, i) => ({ ...m, slots: slots[i] })) };
    return;
  }
  const [models, slots] = await Promise.all([request('/v1/models'), request('/slots').catch(() => null)]);
  const m = models?.data?.[0] || {};
  // Started without --alias, the model's name is its whole path.
  const alias = props.model_alias && props.model_alias !== props.model_path ? props.model_alias : null;
  state = {
    build: props.build_info || null,
    router: false,
    models: [
      {
        id: alias || fileName(props.model_path) || m.id,
        file: props.model_path,
        ftype: props.model_ftype,
        sleeping: props.is_sleeping === true,
        meta: { ...m.meta, n_ctx: props.default_generation_settings?.n_ctx || m.meta?.n_ctx },
        slots,
      },
    ],
  };
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
const params = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${Math.round(n / 1e6)}M` : null);
const fileName = (p) => (p ? String(p).split(/[\\/]/).pop() : null);

function itemsFrom(s) {
  if (!s) return [];
  // "b12669-30ec35ae2" is build 12669.
  const build = s.build?.match(/^b(\d+)/)?.[1];
  return s.models.map((m) => {
    const loading = m.status?.value === 'loading';
    const running = busy(m.slots);
    return {
      app: 'llamacpp',
      kind: 'model',
      id: `llamacpp:model:${m.id}`,
      model: m.id,
      name: m.id,
      host: build ? `llama.cpp build ${build}` : 'llama.cpp',
      where: [params(m.meta?.n_params), m.ftype || m.meta?.ftype].filter(Boolean).join(' · ') || null,
      status: 'loaded',
      facts: [
        ['State', loading ? 'Loading' : m.sleeping ? 'Asleep: loads again on the next request' : null],
        ['Size', bytes(m.meta?.size)],
        ['Context', Number.isFinite(m.meta?.n_ctx) && m.meta.n_ctx > 0 ? `${m.meta.n_ctx.toLocaleString('en')} tokens` : null],
        ['Answering', running ? `${running} of ${m.slots.length} at once` : null],
        ['File', s.router || fileName(m.file) === m.id ? null : fileName(m.file)],
      ].filter(([, v]) => v),
      // Its size, about what it takes: llama.cpp doesn't say.
      memory: m.meta?.size > 0 ? { used: m.meta.size, about: true } : null,
      actions: s.router && !loading ? ['unload'] : [],
    };
  });
}

// llama.cpp's rows from the last check, which checks again in the background.
function snapshot() {
  poll();
  return itemsFrom(state);
}

// In router mode, unloads a model. Its row goes at once, without waiting for
// the next check.
async function act(item, action) {
  if (action !== 'unload' || !state?.router) return { ok: false, error: "That can't be done here." };
  try {
    await request('/models/unload', { model: item.model });
    unloads++;
    state = { ...state, models: state.models.filter((m) => m.id !== item.model) };
    refreshedAt = 0;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Couldn't unload it: ${err.message}` };
  }
}

module.exports = { snapshot, configure, act, itemsFrom, fromEnv, DEFAULT_URL };
