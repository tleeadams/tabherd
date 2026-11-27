'use strict';

// ComfyUI's jobs as cards: the running and queued ones, and for a few minutes
// after, the ones just finished, with their first output. Also the models
// it has loaded, for the Memory and models card. Comfy Desktop
// records each ComfyUI it runs in comfy-procs/<installation>.json, with its
// port; a ComfyUI started some other way is looked for on its usual port.
// ComfyUI has no login, and it answers requests that carry no Origin, as a
// server's own requests don't.
//
// ComfyUI only sends a job's progress to the page that queued it. Comfy
// Desktop shows that progress in its window's title, so on Windows the
// percentage comes from there.

const fs = require('fs');
const os = require('os');
const path = require('path');
const terminals = require('./terminals');

const IS_WIN = process.platform === 'win32';
// Where Comfy Desktop keeps its records, by system.
const DESKTOP_DIRS = IS_WIN
  ? [path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Comfy Desktop')]
  : process.platform === 'darwin'
    ? [path.join(os.homedir(), 'Library', 'Application Support', 'Comfy Desktop')]
    : [path.join(os.homedir(), '.local', 'state', 'comfyui-desktop-2'), path.join(os.homedir(), '.config', 'comfyui-desktop-2')];
// Where to look for a ComfyUI that Comfy Desktop didn't start: Settings'
// ComfyUI address, or its usual one.
const USUAL_URL = 'http://127.0.0.1:8188';
let otherUrl = USUAL_URL;

function configure({ url } = {}) {
  otherUrl = (url || USUAL_URL).replace(/\/+$/, '');
}
const REFRESH_MS = 1500;
const REQUEST_MS = 2000;
// A finished job leaves the dashboard at once; for this long after, its
// outcome and output are there for the ding and the notification list. A
// failed one keeps its card until it's cleared, from up to a day ago.
const FINISHED_SHOWN_MS = 5 * 60 * 1000;
const FAILED_SHOWN_MS = 24 * 60 * 60 * 1000;
// How long an output image stays available, for the notification list.
const PREVIEW_KEPT_MS = 24 * 60 * 60 * 1000;
const NAMES_REFRESH_MS = 60 * 1000;
// ComfyUI can stop answering for a minute or more, as while it loads a model.
// Until it answers again, its cards stay as it last said: as long as Comfy
// Desktop lists it as running, or for this long when there's no Comfy Desktop
// to go by.
const STALL_KEPT_MS = 2 * 60 * 1000;

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The ComfyUIs running now: [{ id, name, url, desktopPid, installPath }].
// A record left by a ComfyUI that crashed has a process that's gone.
function instances(dirs = DESKTOP_DIRS, other = otherUrl) {
  const found = [];
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(path.join(dir, 'comfy-procs'));
    } catch {
      continue;
    }
    const installs = readJson(path.join(dir, 'installations.json')) || [];
    for (const n of names) {
      const r = n.endsWith('.json') ? readJson(path.join(dir, 'comfy-procs', n)) : null;
      if (!r || !Number.isInteger(r.port) || r.childExitedAt || (r.childPid && !isRunning(r.childPid))) continue;
      const inst = Array.isArray(installs) ? installs.find((i) => i.id === r.installationId) : null;
      found.push({
        id: String(r.installationId || r.port),
        name: inst?.name || 'ComfyUI',
        url: `http://127.0.0.1:${r.port}`,
        desktopPid: Number.isInteger(r.desktopPid) && isRunning(r.desktopPid) ? r.desktopPid : null,
        installPath: r.installPath || inst?.installPath || null,
      });
    }
  }
  if (other && !found.some((f) => f.url === other)) found.push({ id: 'comfyui', name: 'ComfyUI', url: other, desktopPid: null, installPath: null });
  return found;
}

async function get(base, route) {
  const res = await fetch(base + route, { signal: AbortSignal.timeout(REQUEST_MS) });
  if (!res.ok) throw new Error(`ComfyUI answered ${res.status}`);
  return res.json();
}

async function post(base, route, body) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  if (!res.ok) throw new Error(`ComfyUI answered ${res.status}`);
  return res.json().catch(() => ({}));
}

// ---- workflow names ------------------------------------------------------------

// A job only carries its workflow's ID. Saved workflows are files whose
// contents have that ID, so each is read once (again if it changes) to map ID
// to name. An unsaved workflow has no file, and so no name here.
const workflowFiles = new Map();
const namesAt = new Map();

async function refreshNames(inst, wanted) {
  if (!wanted.length || Date.now() - (namesAt.get(inst.id) || 0) < NAMES_REFRESH_MS) return;
  namesAt.set(inst.id, Date.now());
  const files = workflowFiles.get(inst.id) || new Map();
  workflowFiles.set(inst.id, files);
  const list = await get(inst.url, '/api/userdata?dir=workflows&recurse=true&full_info=true').catch(() => []);
  for (const f of Array.isArray(list) ? list.slice(0, 500) : []) {
    if (typeof f?.path !== 'string' || !f.path.endsWith('.json')) continue;
    const known = files.get(f.path);
    if (known && known.modified === f.modified) continue;
    const wf = await get(inst.url, `/api/userdata/${encodeURIComponent(`workflows/${f.path}`)}`).catch(() => null);
    files.set(f.path, { modified: f.modified, id: wf?.id || null });
  }
}

function workflowName(instId, workflowId) {
  for (const [file, f] of workflowFiles.get(instId) || []) {
    if (workflowId && f.id === workflowId) return path.basename(file, '.json');
  }
  return null;
}

// What Comfy Desktop's window title says:
// "<installation> · [39%] *<workflow> - ComfyUI · Comfy Desktop v1.2.1", or
// "… · [39%][12%] <node> · …" while one node runs. The first percentage is
// the running job's.
function parseTitle(title) {
  if (!title) return null;
  const parts = String(title).split(' · ');
  const page = parts.length >= 3 ? parts.slice(1, -1).join(' · ') : String(title);
  const m = page.match(/^\s*(?:\[(\d{1,3})%\])?(?:\[(\d{1,3})%\])?(?:\[\d+ nodes running\])?\s*\*?\s*(.*?)\s*$/);
  if (!m) return null;
  const rest = m[3].replace(/ - ComfyUI$/, '');
  return {
    percent: m[1] ? Math.min(100, Number(m[1])) : null,
    // The workflow's name, when the title shows it rather than a node's.
    workflow: m[2] || !/ - ComfyUI$/.test(m[3]) ? null : rest || null,
  };
}

// ---- jobs as cards ------------------------------------------------------------------

// The outputs the dashboard may show, so the image proxy serves only those.
// Each with when it stops being served.
const previews = new Map();
const previewKey = (instId, p) => [instId, p.type || 'output', p.subfolder || '', p.filename].join('\u0000');

function previewFor(inst, job) {
  const p = job.preview_output;
  if (!p?.filename || p.mediaType !== 'images') return null;
  previews.set(previewKey(inst.id, p), Date.now() + PREVIEW_KEPT_MS);
  const q = new URLSearchParams({ i: inst.id, filename: p.filename, subfolder: p.subfolder || '', type: p.type || 'output' });
  return `/api/comfy/view?${q}`;
}

function took(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// One installation's jobs: cards for those running, queued or failed, and
// what became of those that finished in the last few minutes.
function itemsFor(inst, active, recent, { now = Date.now(), title = null } = {}) {
  const shown = parseTitle(title);
  const running = active.filter((j) => j.status === 'in_progress');
  const pending = active.filter((j) => j.status === 'pending').sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.create_time - b.create_time);
  const card = (job, fields) => {
    const name = workflowName(inst.id, job.workflow_id);
    return {
      app: 'comfy',
      kind: 'job',
      id: `comfy:${inst.id}:${job.id}`,
      jobId: job.id,
      instance: inst.id,
      name: name || 'Unsaved workflow',
      title: name,
      host: inst.name,
      cwd: inst.installPath,
      pid: inst.desktopPid,
      startedAt: job.create_time || null,
      outputs: job.outputs_count || 0,
      ...fields,
    };
  };
  const items = [];
  for (const job of running) {
    // The title's percentage is the running job's, when there's just one.
    const percent = running.length === 1 && shown?.percent !== null ? shown?.percent : null;
    items.push(
      card(job, {
        status: 'busy',
        statusSince: job.execution_start_time || job.create_time,
        progress: Number.isFinite(percent) ? { value: percent, max: 100 } : null,
        facts: [],
        // It leaves once it's done, which counts as finishing.
        leavesWhenDone: true,
        actions: ['focus', 'stop'],
      }),
    );
  }
  pending.forEach((job, i) =>
    items.push(
      card(job, {
        status: 'queued',
        statusSince: job.create_time,
        facts: [['Queue', `${i + 1} of ${pending.length}`]],
        leavesWhenDone: true,
        actions: ['focus', 'cancel'],
      }),
    ),
  );
  const finished = [];
  for (const job of recent) {
    const ended = job.execution_end_time || job.create_time;
    if (!ended) continue;
    if (job.status === 'failed') {
      if (now - ended > FAILED_SHOWN_MS) continue;
      const error = job.execution_error?.exception_message || job.execution_error?.message || null;
      items.push(
        card(job, {
          status: 'waiting',
          statusLabel: 'Failed',
          waitingFor: error ? `Failed: ${String(error).slice(0, 200)}` : 'Failed',
          statusSince: ended,
          facts: [],
          actions: ['focus', 'dismiss'],
        }),
      );
    } else if (now - ended <= FINISHED_SHOWN_MS) {
      finished.push({
        id: `comfy:${inst.id}:${job.id}`,
        label: job.status === 'cancelled' ? 'Cancelled' : 'Finished',
        preview: job.status === 'cancelled' ? null : previewFor(inst, job),
        took: took((job.execution_end_time || 0) - (job.execution_start_time || 0)),
        at: ended,
      });
    }
  }
  return { items, finished };
}

// ---- loaded models ---------------------------------------------------------------

// ComfyUI doesn't list the models it has loaded, but a job's loader nodes name
// them, and ComfyUI keeps what its last job loaded in memory for the next one,
// until it needs the room or is told to free it. So the models shown are the
// ones the latest job to run loaded, until Unload frees them. That frees them
// all, as ComfyUI can't free just one.
const MODEL_FILE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;
// What the loader's input says a model is.
const MODEL_TYPES = [
  [/^ckpt_name$/, 'Checkpoint'],
  [/^unet_name$/, 'Diffusion model'],
  [/^clip_name\d*$/, 'Text encoder'],
  [/^vae_name$/, 'VAE'],
  [/^lora_name/, 'LoRA'],
  [/^control_net_name$/, 'ControlNet'],
  [/^clip_vision_name$/, 'CLIP vision'],
];

// The model files a job's workflow names, once each: [{ file, type }].
function modelsIn(prompt) {
  const found = new Map();
  for (const node of Object.values(prompt || {})) {
    for (const [key, value] of Object.entries(node?.inputs || {})) {
      if (typeof value !== 'string' || !MODEL_FILE.test(value) || found.has(value)) continue;
      found.set(value, { file: value, type: MODEL_TYPES.find(([re]) => re.test(key))?.[1] || null });
    }
  }
  return [...found.values()];
}

// The job whose models are loaded: the one running, else the last to start.
function latestRun(active, recent) {
  return (
    active.find((j) => j.status === 'in_progress') ||
    recent.filter((j) => j.execution_start_time).sort((a, b) => b.execution_start_time - a.execution_start_time)[0] ||
    null
  );
}

// Each installation's latest job's models, read once per job:
// { jobId, workflowId, models }.
const loaded = new Map();
// The job whose models Unload freed, by installation. They show again once
// another job runs.
const freed = new Map();

async function refreshModels(inst, job) {
  if (!job) {
    loaded.delete(inst.id);
    return;
  }
  if (loaded.get(inst.id)?.jobId === job.id) return;
  // A running job's workflow is in the queue, as [number, id, prompt, …]; a
  // finished one's is in its record.
  const prompt =
    job.status === 'in_progress'
      ? (await get(inst.url, '/queue')).queue_running?.find((q) => q[1] === job.id)?.[2]
      : (await get(inst.url, `/api/jobs/${encodeURIComponent(job.id)}`)).workflow?.prompt;
  // Finished between the two requests: read it again next time.
  if (!prompt) return;
  loaded.set(inst.id, { jobId: job.id, workflowId: job.workflow_id || null, models: await withSizes(inst, modelsIn(prompt)) });
}

// The folder each type of model is kept in, looked in first, as another
// folder can have a file of the same name.
const TYPE_FOLDERS = {
  Checkpoint: 'checkpoints',
  'Diffusion model': 'diffusion_models',
  'Text encoder': 'text_encoders',
  VAE: 'vae',
  LoRA: 'loras',
  ControlNet: 'controlnet',
  'CLIP vision': 'clip_vision',
};

// The models with the size of each one's file, from ComfyUI's lists of its
// model folders: about what each takes in memory, as ComfyUI doesn't say.
// A ComfyUI too old to list them gives none.
async function withSizes(inst, models) {
  let lists;
  try {
    const folders = await get(inst.url, '/experiment/models');
    lists = await Promise.all(
      folders.map(async (f) => [f.name, await get(inst.url, `/experiment/models/${encodeURIComponent(f.name)}`).catch(() => [])]),
    );
  } catch {
    return models;
  }
  // A model in a subfolder is named with the system's slash.
  const slashed = (name) => String(name).replace(/\\/g, '/');
  const sizes = new Map(lists.map(([folder, files]) => [folder, new Map((Array.isArray(files) ? files : []).map((f) => [slashed(f.name), f.size]))]));
  return models.map((m) => {
    const file = slashed(m.file);
    const size = [sizes.get(TYPE_FOLDERS[m.type]), ...sizes.values()].map((s) => s?.get(file)).find((n) => n > 0);
    return size ? { ...m, size } : m;
  });
}

const bytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : null);

function modelItems(inst, l) {
  if (!l || freed.get(inst.id) === l.jobId) return [];
  const workflow = workflowName(inst.id, l.workflowId);
  return l.models.map((m) => ({
    app: 'comfy',
    kind: 'model',
    id: `comfy:${inst.id}:model:${m.file}`,
    instance: inst.id,
    name: m.file.split(/[\\/]/).pop(),
    host: inst.name,
    // A model in a subfolder, such as "flux\model.safetensors".
    where: /[\\/]/.test(m.file) ? m.file : null,
    status: 'loaded',
    facts: [
      ['Type', m.type],
      ['Size', bytes(m.size)],
      ['Loaded by', workflow],
    ].filter(([, v]) => v),
    memory: m.size ? { used: m.size, about: true } : null,
    actions: ['unload'],
  }));
}

// ---- polling ---------------------------------------------------------------------

let state = [];
let refreshing = null;
let refreshedAt = 0;

// The recently finished jobs, with the failed ones added that aren't among
// them: a failed job keeps its card for longer than ten more jobs may take.
function withFailed(recent, failed) {
  const ids = new Set(recent.map((j) => j.id));
  return [...recent, ...failed.filter((j) => !ids.has(j.id))];
}

// An installation's last answer, kept while it isn't answering (see
// STALL_KEPT_MS), or null. A ComfyUI that's closed isn't listed, so its cards
// go at once.
function keptThroughStall(last, inst, now = Date.now()) {
  if (!last) return null;
  return inst.desktopPid || now - last.at < STALL_KEPT_MS ? { ...last, inst } : null;
}

async function refresh() {
  const next = [];
  await Promise.all(
    instances().map(async (inst) => {
      let jobs;
      try {
        const [active, recent, failed] = await Promise.all([
          get(inst.url, '/api/jobs?status=in_progress,pending&limit=100'),
          get(inst.url, '/api/jobs?status=completed,failed,cancelled&limit=10&sort_by=created_at&sort_order=desc'),
          get(inst.url, '/api/jobs?status=failed&limit=20&sort_by=created_at&sort_order=desc'),
        ]);
        jobs = { active: active.jobs || [], recent: withFailed(recent.jobs || [], failed.jobs || []) };
      } catch {
        // Not running, or not answering this time.
        const kept = keptThroughStall(state.find((s) => s.inst.id === inst.id), inst);
        if (kept) next.push(kept);
        return;
      }
      next.push({ inst, ...jobs, at: Date.now() });
      const ids = [...jobs.active, ...jobs.recent].map((j) => j.workflow_id).filter((id) => id && !workflowName(inst.id, id));
      await Promise.all([refreshNames(inst, ids), refreshModels(inst, latestRun(jobs.active, jobs.recent))]).catch(() => {});
    }),
  );
  state = next;
}

function poll() {
  if (!refreshing && Date.now() - refreshedAt > REFRESH_MS) {
    refreshing = refresh()
      .catch(() => {})
      .finally(() => {
        refreshing = null;
        refreshedAt = Date.now();
      });
  }
}

// The jobs as cards and the loaded models as rows, from the last check, and
// the Comfy Desktop windows whose titles the next snapshot needs. Checks
// again in the background.
function snapshot() {
  poll();
  const now = Date.now();
  for (const [key, until] of previews) if (until < now) previews.delete(key);
  const items = [];
  const finished = [];
  for (const s of state) {
    const out = itemsFor(s.inst, s.active, s.recent, { now, title: s.inst.desktopPid ? terminals.titleFor(s.inst.desktopPid) : null });
    items.push(...out.items, ...modelItems(s.inst, loaded.get(s.inst.id)));
    finished.push(...out.finished);
  }
  return { items, finished, windowPids: state.map((s) => s.inst.desktopPid).filter(Boolean) };
}

// ---- actions -------------------------------------------------------------------

// Stops a running job, or takes a queued one out of the queue.
async function cancel(item) {
  const s = state.find((x) => x.inst.id === item.instance);
  if (!s) return { ok: false, error: "That ComfyUI isn't answering." };
  try {
    const r = await post(s.inst.url, `/api/jobs/${encodeURIComponent(item.jobId)}/cancel`);
    return r.cancelled === false ? { ok: false, error: 'It had already finished.' } : { ok: true };
  } catch (err) {
    return { ok: false, error: `Couldn't cancel it: ${err.message}` };
  }
}

// Frees every model the installation has loaded: ComfyUI can't free just one.
// They go from the card at once, and come back when another job runs.
async function unload(item) {
  const s = state.find((x) => x.inst.id === item.instance);
  if (!s) return { ok: false, error: "That ComfyUI isn't answering." };
  try {
    await post(s.inst.url, '/free', { unload_models: true, free_memory: true });
    const l = loaded.get(s.inst.id);
    if (l) freed.set(s.inst.id, l.jobId);
    const n = l?.models.length || 0;
    return { ok: true, done: n > 1 ? `Unloaded ${s.inst.name}'s ${n} models` : `Unloaded ${item.name}` };
  } catch (err) {
    return { ok: false, error: `Couldn't unload them: ${err.message}` };
  }
}

// An output image of a job, fetched from its ComfyUI. Only outputs of jobs
// the dashboard has reported, in the last day, are served.
async function view({ i, filename, subfolder = '', type = 'output' }) {
  const s = state.find((x) => x.inst.id === i);
  if (!s || !previews.has(previewKey(i, { filename, subfolder, type }))) return null;
  const q = new URLSearchParams({ filename, subfolder, type, preview: 'webp;80' });
  const res = await fetch(`${s.inst.url}/view?${q}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  return { type: res.headers.get('content-type') || 'image/webp', body: Buffer.from(await res.arrayBuffer()) };
}

module.exports = {
  snapshot,
  configure,
  cancel,
  unload,
  view,
  instances,
  itemsFor,
  parseTitle,
  modelsIn,
  latestRun,
  modelItems,
  withSizes,
  withFailed,
  keptThroughStall,
  STALL_KEPT_MS,
};
