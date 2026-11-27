'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const comfy = require('../lib/comfy');
const localai = require('../lib/localai');

// ---- ComfyUI ----------------------------------------------------------------------

test("Comfy Desktop's window title gives the running job's progress and the open workflow", () => {
  assert.deepEqual(comfy.parseTitle('Studio · [39%] *Portrait v2 - ComfyUI · Comfy Desktop v1.2.1'), { percent: 39, workflow: 'Portrait v2' });
  assert.deepEqual(comfy.parseTitle('Studio · [39%][12%] KSampler · Comfy Desktop v1.2.1'), { percent: 39, workflow: null }, "a node's name isn't a workflow's");
  assert.deepEqual(comfy.parseTitle('Studio · Portrait v2 - ComfyUI · Comfy Desktop v1.2.1'), { percent: null, workflow: 'Portrait v2' });
  assert.equal(comfy.parseTitle(null), null);
});

test('ComfyUI jobs become cards while running, queued or failed; finished ones leave, with their output', () => {
  const inst = { id: 'inst-1', name: 'Studio', url: 'http://127.0.0.1:8188', desktopPid: 4321, installPath: '/comfy' };
  const now = 2_000_000;
  const active = [
    { id: 'b', status: 'pending', priority: 2, create_time: now - 1000 },
    { id: 'r', status: 'in_progress', create_time: now - 60000 },
    { id: 'a', status: 'pending', priority: 1, create_time: now - 2000 },
  ];
  const recent = [
    { id: 'done', status: 'completed', create_time: now - 90000, execution_start_time: now - 80000, execution_end_time: now - 20000, outputs_count: 2, preview_output: { filename: 'x.png', subfolder: '', type: 'output', mediaType: 'images' } },
    { id: 'bad', status: 'failed', create_time: now - 90000, execution_end_time: now - 10000, execution_error: { exception_message: 'Out of memory' } },
    { id: 'old', status: 'completed', create_time: 1, execution_end_time: 2 },
  ];
  const { items, finished } = comfy.itemsFor(inst, active, recent, { now, title: 'Studio · [40%] Portrait - ComfyUI · Comfy Desktop v1.2.1' });
  assert.deepEqual(
    items.map((i) => [i.jobId, i.status, i.statusLabel || null]),
    [
      ['r', 'busy', null],
      ['a', 'queued', null],
      ['b', 'queued', null],
      ['bad', 'waiting', 'Failed'],
    ],
    'a finished job has no card',
  );
  const [running, first] = items;
  assert.deepEqual(running.progress, { value: 40, max: 100 });
  assert.deepEqual(running.actions, ['focus', 'stop']);
  assert.ok(running.leavesWhenDone, 'its leaving counts as finishing');
  assert.equal(running.pid, 4321, 'Go to window goes to Comfy Desktop');
  assert.equal(running.id, 'comfy:inst-1:r');
  assert.deepEqual(first.facts, [['Queue', '1 of 2']]);
  assert.deepEqual(first.actions, ['focus', 'cancel']);
  assert.equal(items[3].waitingFor, 'Failed: Out of memory');
  assert.deepEqual(items[3].actions, ['focus', 'dismiss'], 'a failed one stays until cleared');
  assert.deepEqual(
    finished.map((f) => [f.id, f.label, f.took]),
    [['comfy:inst-1:done', 'Finished', '1m 0s']],
    "how the finished one ended, for its notification; the hour-old one isn't news",
  );
  assert.match(finished[0].preview, /^\/api\/comfy\/view\?i=inst-1&filename=x\.png/);
});

test("each ComfyUI Comfy Desktop runs is found from its records, and a crashed one's isn't", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-comfy-'));
  fs.mkdirSync(path.join(dir, 'comfy-procs'));
  fs.writeFileSync(path.join(dir, 'installations.json'), JSON.stringify([{ id: 'inst-1', name: 'Studio', installPath: '/comfy' }]));
  fs.writeFileSync(path.join(dir, 'comfy-procs', 'inst-1.json'), JSON.stringify({ installationId: 'inst-1', port: 8189, childPid: process.pid, desktopPid: process.pid }));
  fs.writeFileSync(path.join(dir, 'comfy-procs', 'inst-2.json'), JSON.stringify({ installationId: 'inst-2', port: 8190, childPid: 999999999 }));
  const found = comfy.instances([dir]);
  assert.deepEqual(
    found.map((f) => [f.name, f.url]),
    [
      ['Studio', 'http://127.0.0.1:8189'],
      ['ComfyUI', 'http://127.0.0.1:8188'],
    ],
    "and the usual port, for a ComfyUI run some other way",
  );
  assert.deepEqual(
    comfy.instances([dir], 'http://127.0.0.1:9000').map((f) => f.url),
    ['http://127.0.0.1:8189', 'http://127.0.0.1:9000'],
    "or the address in Settings",
  );
});

test("a ComfyUI that stops answering keeps its cards while it's running, and failed jobs aren't crowded out", () => {
  const desktop = { id: 'inst-1', name: 'Studio', url: 'http://127.0.0.1:8189', desktopPid: 4321, installPath: '/comfy' };
  const other = { id: 'comfyui', name: 'ComfyUI', url: 'http://127.0.0.1:8188', desktopPid: null, installPath: null };
  const last = { inst: { ...desktop, name: 'Old name' }, active: [{ id: 'r', status: 'in_progress' }], recent: [], at: 1000 };
  assert.deepEqual(comfy.keptThroughStall(last, desktop, 1000 + 60 * 60 * 1000), { ...last, inst: desktop }, 'while Comfy Desktop lists it, however long');
  const lastOther = { ...last, inst: other };
  assert.ok(comfy.keptThroughStall(lastOther, other, 1000 + comfy.STALL_KEPT_MS - 1), 'without Comfy Desktop, for a while');
  assert.equal(comfy.keptThroughStall(lastOther, other, 1000 + comfy.STALL_KEPT_MS + 1), null, 'and no longer');
  assert.equal(comfy.keptThroughStall(undefined, desktop, 1000), null, 'nothing to keep before it first answers');

  const recent = [{ id: 'failed-new', status: 'failed' }, ...Array.from({ length: 9 }, (_, i) => ({ id: `done-${i}`, status: 'completed' }))];
  const merged = comfy.withFailed(recent, [{ id: 'failed-new', status: 'failed' }, { id: 'failed-old', status: 'failed' }]);
  assert.deepEqual(
    merged.map((j) => j.id),
    [...recent.map((j) => j.id), 'failed-old'],
    'a failed job older than the last ten is added, and each job is there once',
  );
});

test("ComfyUI's loaded models are the ones its latest job's loaders name", () => {
  const prompt = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'flux\\dev.safetensors', weight_dtype: 'default' } },
    2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: 't5xxl.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: 'ae.sft' } },
    4: { class_type: 'LoraLoader', inputs: { lora_name: 'style.safetensors', model: ['1', 0], strength_model: 1 } },
    5: { class_type: 'SaveImage', inputs: { filename_prefix: 'cat.png', images: ['9', 0] } },
    6: { class_type: 'UNETLoader', inputs: { unet_name: 'flux\\dev.safetensors' } },
  };
  assert.deepEqual(
    comfy.modelsIn(prompt),
    [
      { file: 'flux\\dev.safetensors', type: 'Diffusion model' },
      { file: 't5xxl.safetensors', type: 'Text encoder' },
      { file: 'clip_l.safetensors', type: 'Text encoder' },
      { file: 'ae.sft', type: 'VAE' },
      { file: 'style.safetensors', type: 'LoRA' },
    ],
    'only model files, and one named twice once',
  );

  const queued = [{ id: 'q', status: 'pending' }];
  const recent = [
    { id: 'skipped', status: 'cancelled', create_time: 9 },
    { id: 'last', status: 'completed', execution_start_time: 5 },
    { id: 'older', status: 'failed', execution_start_time: 3 },
  ];
  assert.equal(comfy.latestRun(queued, recent).id, 'last', 'a job cancelled before it ran loaded nothing');
  assert.equal(comfy.latestRun([{ id: 'now', status: 'in_progress' }, ...queued], recent).id, 'now');
  assert.equal(comfy.latestRun(queued, []), null);

  const items = comfy.modelItems({ id: 'inst-1', name: 'Studio' }, { jobId: 'last', workflowId: null, models: comfy.modelsIn(prompt).slice(0, 2) });
  assert.deepEqual(
    items.map((i) => [i.id, i.name, i.where, i.facts]),
    [
      ['comfy:inst-1:model:flux\\dev.safetensors', 'dev.safetensors', 'flux\\dev.safetensors', [['Type', 'Diffusion model']]],
      ['comfy:inst-1:model:t5xxl.safetensors', 't5xxl.safetensors', null, [['Type', 'Text encoder']]],
    ],
  );
  assert.ok(
    items.every((i) => i.app === 'comfy' && i.kind === 'model' && i.host === 'Studio' && i.actions.includes('unload')),
    'rows for the Memory and models card, each with Unload',
  );
});

test("ComfyUI's loaded models are as big as their files, looked for in their own type's folder first", async () => {
  const lists = {
    checkpoints: [{ name: 'ae.sft', size: 9e9 }],
    vae: [{ name: 'ae.sft', size: 3.4e8 }],
    diffusion_models: [{ name: 'flux\\dev.safetensors', size: 2.38e10 }],
  };
  const server = http.createServer((req, res) => {
    const folder = decodeURIComponent(req.url.match(/^\/experiment\/models\/?(.*)$/)?.[1] ?? '');
    const body = req.url === '/experiment/models' ? Object.keys(lists).map((name) => ({ name, folders: [] })) : lists[folder];
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body || {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const inst = { id: 'inst-1', name: 'Studio', url: `http://127.0.0.1:${server.address().port}` };
    const models = [
      { file: 'flux\\dev.safetensors', type: 'Diffusion model' },
      { file: 'ae.sft', type: 'VAE' },
      { file: 'gone.safetensors', type: 'LoRA' },
    ];
    const sized = await comfy.withSizes(inst, models);
    assert.deepEqual(
      sized.map((m) => m.size),
      [2.38e10, 3.4e8, undefined],
      'a VAE named like a checkpoint is the VAE, and a file not listed has no size',
    );
    const [item] = comfy.modelItems(inst, { jobId: 'j', workflowId: null, models: sized });
    assert.deepEqual(item.facts, [['Type', 'Diffusion model'], ['Size', '23.8 GB']]);
    assert.deepEqual(item.memory, { used: 2.38e10, about: true });
    assert.equal(comfy.modelItems(inst, { jobId: 'j', workflowId: null, models: sized.slice(2) })[0].memory, null);
  } finally {
    server.close();
  }
  assert.deepEqual(await comfy.withSizes({ url: 'http://127.0.0.1:9' }, [{ file: 'a.safetensors', type: null }]), [{ file: 'a.safetensors', type: null }], 'none when ComfyUI gives no lists');
});

// ---- LocalAI --------------------------------------------------------------------

// A stand-in LocalAI, answering as its source says it does, and recording
// what it was asked.
function fakeLocalAI() {
  const asked = [];
  const now = Date.now();
  const routes = {
    'GET /.well-known/localai.json': { version: 'v5.0.1', capabilities: { chats: true, agent_jobs: true } },
    'GET /system': { backends: ['llama-cpp'], loaded_models: [{ id: 'qwen3-8b', backend: 'llama-cpp', size_vram: 6_400_000_000, process: { pid: 77, rss_bytes: 900_000_000, cpu_percent: 12.4, started_at: new Date(now - 60000).toISOString() } }] },
    'GET /api/operations': { operations: [{ id: 'op1', jobID: 'job-1', name: 'flux-dev', progress: 42, cancellable: true, currentBytes: 4.2e9, totalBytes: 1e10, message: 'downloading' }] },
    'GET /api/chats': {
      conversations: [
        { id: 'c1', title: 'Plan the trip', model: 'qwen3-8b', kind: 'chat', running: true, created: new Date(now - 300000).toISOString(), updated: new Date(now - 1000).toISOString() },
        { id: 'c2', title: 'Long research', model: 'qwen3-8b', kind: 'chat', running: false, last_turn: 'paused', created: new Date(now - 9e6).toISOString(), updated: new Date(now - 8e6).toISOString() },
        { id: 'c3', title: 'Just finished', kind: 'chat', running: false, last_turn: 'done', updated: new Date(now - 5000).toISOString() },
        { id: 'c5', title: 'Broke', kind: 'chat', running: false, last_turn: 'failed', updated: new Date(now - 60000).toISOString() },
        { id: 'c4', title: 'A helper', kind: 'subagent', parent_id: 'c1', running: true },
      ],
    },
    'GET /api/agent/jobs': [{ id: 'j1', task_id: 'nightly-report', status: 'running', started_at: new Date(now - 5000).toISOString() }],
    'POST /backend/shutdown': { message: 'model stopped' },
    'POST /api/chats/c1/stop': {},
    'POST /api/operations/job-1/cancel': { success: true },
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const route = `${req.method} ${req.url.split('?')[0]}`;
      asked.push({ route, auth: req.headers.authorization || null, body });
      const answer = routes[route];
      res.writeHead(answer ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer || { error: 'not found' }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, asked, url: `http://127.0.0.1:${server.address().port}` })));
}

const settle = async () => {
  localai.snapshot();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 40));
    const items = localai.snapshot();
    if (items.length) return items;
  }
  return localai.snapshot();
};

test("LocalAI's loaded models, downloads, agent chats and agent jobs become cards", async () => {
  const fake = await fakeLocalAI();
  try {
    localai.configure({ url: fake.url, key: 'secret' });
    const items = await settle();
    const byKind = (k) => items.filter((i) => i.kind === k);
    const [model] = byKind('model');
    assert.equal(model.name, 'qwen3-8b');
    assert.equal(model.status, 'loaded');
    assert.deepEqual(model.facts, [['Graphics memory', '6.4 GB'], ['Memory', '900 MB'], ['CPU', '12%']]);
    assert.deepEqual(model.memory, { used: 6_400_000_000, graphics: 6_400_000_000 }, 'what it takes is its graphics memory');
    assert.deepEqual(model.actions, ['open', 'unload']);
    assert.deepEqual(byKind('work'), [], 'a model using little of a processor is idle');
    const [download] = byKind('download');
    assert.deepEqual([download.status, download.statusLabel, download.progress], ['busy', 'Downloading', { value: 42, max: 100 }]);
    assert.ok(download.leavesWhenDone, 'its leaving counts as finishing');
    assert.deepEqual(
      byKind('chat').map((c) => [c.name, c.status, c.waitingFor || null]),
      [
        ['Plan the trip', 'busy', null],
        ['Long research', 'waiting', 'Paused: reply to continue'],
        ['Broke', 'waiting', 'Its last turn failed'],
      ],
      "a finished chat, and a subagent's, don't get cards",
    );
    assert.deepEqual(byKind('chat')[0].actions, ['open', 'stop']);
    assert.ok(byKind('chat')[0].leavesWhenDone);
    assert.deepEqual(byKind('chat')[2].actions, ['open', 'dismiss']);
    assert.deepEqual(byKind('agent-job').map((j) => [j.name, j.status]), [['nightly-report', 'busy']]);
    assert.ok(items.every((i) => i.host === 'LocalAI v5.0.1'));
    assert.ok(fake.asked.every((a) => a.auth === 'Bearer secret'), 'the key goes with every request');

    assert.deepEqual(await localai.act(model, 'unload'), { ok: true });
    assert.deepEqual(await localai.act(byKind('chat')[0], 'stop'), { ok: true });
    assert.deepEqual(await localai.act(download, 'cancel'), { ok: true });
    assert.equal(fake.asked.find((a) => a.route === 'POST /backend/shutdown').body, '{"model":"qwen3-8b"}');
    assert.ok(fake.asked.some((a) => a.route === 'POST /api/chats/c1/stop'));
    assert.ok(fake.asked.some((a) => a.route === 'POST /api/operations/job-1/cancel'));
    assert.equal((await localai.act(model, 'stop')).ok, false, "a model can't be stopped, only unloaded");
  } finally {
    fake.server.close();
    localai.configure({});
  }
});

test('a LocalAI model keeping a processor busy gets a Working card until it stops', () => {
  const t0 = Date.now();
  const loaded = (cpu) => [{ id: 'qwen3-8b', backend: 'llama-cpp', process: { pid: 77, ...(cpu === undefined ? {} : { cpu_percent: cpu }) } }];
  // One reading every two seconds, as the dashboard takes them.
  const readings = [3, 97, undefined, 5, 90, 5, 4];
  const seen = [];
  let working = new Map();
  readings.forEach((cpu, i) => {
    working = localai.trackWork(working, loaded(cpu), t0 + i * 2000);
    seen.push(working.get('qwen3-8b')?.since ?? null);
  });
  assert.deepEqual(
    seen,
    [null, t0 + 2000, t0 + 2000, t0 + 2000, t0 + 2000, t0 + 2000, null],
    'it starts at the first busy reading, and one low or missing reading in a row is not the end',
  );
  assert.equal(localai.trackWork(new Map([['qwen3-8b', { since: t0, quiet: 0 }]]), [], t0).size, 0, 'an unloaded model stops');

  const s = { version: 'v4.12.1', models: loaded(97), working: new Map([['qwen3-8b', { since: t0, quiet: 0 }]]), operations: [], chats: [], jobs: [] };
  const work = localai.itemsFrom(s, { now: t0 + 5000 }).find((i) => i.kind === 'work');
  assert.deepEqual(
    [work.id, work.name, work.where, work.status, work.statusSince, work.facts, work.actions],
    ['localai:work:qwen3-8b', 'qwen3-8b', 'llama-cpp', 'busy', t0, [['CPU', '97%']], ['open']],
  );
  assert.equal(work.leavesWhenDone, false, 'a short run leaves quietly');
  assert.equal(localai.itemsFrom(s, { now: t0 + 30000 }).find((i) => i.kind === 'work').leavesWhenDone, true, 'a long one dings when it stops');
  assert.equal(localai.itemsFrom(s, { now: t0 }).filter((i) => i.kind === 'model').length, 1, 'the model is still listed with the others');
});

test("nothing shows while LocalAI isn't running, and a refused key says so", async () => {
  localai.configure({ url: 'http://127.0.0.1:1' });
  await new Promise((r) => setTimeout(r, 300));
  localai.snapshot();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(localai.snapshot(), []);

  const server = http.createServer((req, res) => {
    res.writeHead(401);
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    localai.configure({ url: `http://127.0.0.1:${server.address().port}` });
    const items = await settle();
    assert.deepEqual(items.map((i) => [i.kind, i.status, i.waitingFor]), [['service', 'waiting', 'LocalAI wants an API key: set it in Settings.']]);
  } finally {
    server.close();
    localai.configure({});
  }
});

// ---- Ollama and LM Studio --------------------------------------------------------

const ollama = require('../lib/ollama');
const lmstudio = require('../lib/lmstudio');

test("Ollama's loaded models become cards, with when they'll unload", () => {
  const now = Date.parse('2026-01-02T03:00:00Z');
  const items = ollama.itemsFrom(
    {
      version: '0.40.16',
      models: [
        { name: 'llama3.2:1b', size: 2.1e9, size_vram: 2.1e9, context_length: 4096, expires_at: '2026-01-02T03:04:00Z', details: { parameter_size: '1.2B', quantization_level: 'Q8_0' } },
        { name: 'qwen3:8b', size: 6e9, size_vram: 0, expires_at: '2318-01-01T00:00:00Z', details: {} },
      ],
    },
    { now },
  );
  assert.deepEqual(items[0].facts, [['Graphics memory', '2.1 GB'], ['Size', '2.1 GB'], ['Context', '4,096 tokens'], ['Unloads', 'In 4 min']]);
  assert.equal(items[0].where, '1.2B · Q8_0');
  assert.equal(items[0].host, 'Ollama 0.40.16');
  assert.deepEqual(items[0].actions, ['unload']);
  assert.deepEqual(items[1].facts, [['Graphics memory', 'None, on the CPU'], ['Size', '6.0 GB'], ['Unloads', 'Stays loaded']]);
  assert.deepEqual(
    items.map((i) => i.memory),
    [
      { used: 2.1e9, graphics: 2.1e9 },
      { used: 6e9, graphics: 0 },
    ],
    'what each takes, and how much of it is graphics memory',
  );
});

test('OLLAMA_HOST is read the ways Ollama reads it', () => {
  assert.equal(ollama.fromEnv('0.0.0.0'), 'http://127.0.0.1:11434');
  assert.equal(ollama.fromEnv('127.0.0.1:11500'), 'http://127.0.0.1:11500');
  assert.equal(ollama.fromEnv('https://ollama.example.test'), 'https://ollama.example.test');
  assert.equal(ollama.fromEnv(''), null);
});

test("LM Studio's loaded instances become cards, and Unload goes by instance", async () => {
  const items = lmstudio.itemsFrom({
    v1: true,
    models: [
      { key: 'qwen3-4b', display_name: 'Qwen3 4B', type: 'llm', quantization: { name: 'Q4_K_M' }, size_bytes: 2.5e9, loaded_instances: [{ id: 'qwen3-4b', config: { context_length: 8192, parallel: 4 } }] },
      { key: 'not-loaded', display_name: 'Idle one', loaded_instances: [] },
    ],
  });
  assert.equal(items.length, 1, 'only loaded ones');
  assert.equal(items[0].name, 'Qwen3 4B');
  assert.equal(items[0].where, 'Q4_K_M');
  assert.deepEqual(items[0].facts, [['Size', '2.5 GB'], ['Context', '8,192 tokens'], ['Parallel', '4']]);
  assert.deepEqual(items[0].memory, { used: 2.5e9, about: true }, 'its size, about what it takes');

  const asked = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      asked.push({ route: `${req.method} ${req.url}`, body, auth: req.headers.authorization || null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    lmstudio.configure({ url: `http://127.0.0.1:${server.address().port}`, key: 'tok' });
    assert.deepEqual(await lmstudio.act(items[0], 'unload'), { ok: true });
    assert.deepEqual(asked, [{ route: 'POST /api/v1/models/unload', body: '{"instance_id":"qwen3-4b"}', auth: 'Bearer tok' }]);
  } finally {
    server.close();
    lmstudio.configure({});
  }
});

test('LM Studio is found on the port its server last used', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-lms-'));
  assert.equal(lmstudio.lastPort(home), null);
  fs.mkdirSync(path.join(home, '.lmstudio', '.internal'), { recursive: true });
  fs.writeFileSync(path.join(home, '.lmstudio', '.internal', 'http-server-config.json'), JSON.stringify({ port: 1235, networkInterface: '127.0.0.1' }));
  assert.equal(lmstudio.lastPort(home), 'http://127.0.0.1:1235');
});

test("nvidia-smi's lines give each graphics card's memory and load", () => {
  const memory = require('../lib/memory');
  assert.deepEqual(memory.parseSmi('0, NVIDIA GeForce RTX 5090 Laptop GPU, 2533, 24463, 3\r\n\r\n'), [
    { index: 0, name: 'GeForce RTX 5090 Laptop GPU', used: 2533 * 1048576, total: 24463 * 1048576, busy: 3 },
  ]);
  assert.deepEqual(memory.parseSmi('No devices were found'), []);
  const s = memory.snapshot();
  assert.ok(s.ram.total > 0 && s.ram.used > 0 && s.ram.used <= s.ram.total);
});

// ---- llama.cpp ---------------------------------------------------------------------

const llamacpp = require('../lib/llamacpp');

test("llama.cpp's one model becomes a row, with no Unload", () => {
  const [item] = llamacpp.itemsFrom({
    build: 'b12669-30ec35ae2',
    router: false,
    models: [
      {
        id: 'gemma-4-e4b',
        file: 'C:\\models\\gemma-4-E4B-it-Q4_K_M.gguf',
        ftype: 'Q4_K - Medium',
        sleeping: false,
        meta: { n_params: 7518069290, size: 5319465128, n_ctx: 8192 },
        slots: [{ is_processing: true }, { is_processing: false }, { is_processing: false }, { is_processing: false }],
      },
    ],
  });
  assert.equal(item.app, 'llamacpp');
  assert.equal(item.kind, 'model', 'it goes on the memory card');
  assert.equal(item.host, 'llama.cpp build 12669');
  assert.equal(item.where, '7.5B · Q4_K - Medium');
  assert.deepEqual(item.facts, [['Size', '5.3 GB'], ['Context', '8,192 tokens'], ['Answering', '1 of 4 at once'], ['File', 'gemma-4-E4B-it-Q4_K_M.gguf']]);
  assert.deepEqual(item.actions, [], 'a server started with one model keeps it');
  assert.deepEqual(item.memory, { used: 5319465128, about: true }, 'its size, about what it takes');
  const [unnamed] = llamacpp.itemsFrom({
    build: null,
    router: false,
    models: [{ id: 'gemma-4-E4B-it-Q4_K_M.gguf', file: 'C:\\models\\gemma-4-E4B-it-Q4_K_M.gguf', meta: {}, slots: [] }],
  });
  assert.equal(unnamed.host, 'llama.cpp');
  assert.deepEqual(unnamed.facts, [], 'named for its file, so the file goes unsaid');
  assert.equal(unnamed.memory, null, 'no size, so nothing said');
});

test("llama.cpp's router shows each model loaded or loading, and loaded ones unload", () => {
  const items = llamacpp.itemsFrom({
    build: 'b12669-30ec35ae2',
    router: true,
    models: [
      { id: 'gemma-4-E4B-it-GGUF', status: { value: 'loaded' }, meta: { n_params: 7.5e9, size: 5.3e9, n_ctx: 8192, ftype: 'Q4_K - Medium' }, slots: [{ is_processing: false }] },
      { id: 'qwen3-8b', status: { value: 'loading' }, slots: null },
    ],
  });
  assert.deepEqual(items.map((i) => i.actions), [['unload'], []]);
  assert.deepEqual(items[1].facts, [['State', 'Loading']]);
  assert.ok(!items[0].facts.some(([k]) => k === 'Answering'), 'nothing is said about requests while none run');
  assert.ok(!items[0].facts.some(([k]) => k === 'File'), "the router's models are named for their files already");
});

test('LLAMA_ARG_HOST and LLAMA_ARG_PORT are read as llama-server reads them', () => {
  assert.equal(llamacpp.fromEnv({}), null);
  assert.equal(llamacpp.fromEnv({ LLAMA_ARG_PORT: '8091' }), 'http://127.0.0.1:8091');
  assert.equal(llamacpp.fromEnv({ LLAMA_ARG_HOST: '0.0.0.0' }), 'http://127.0.0.1:8080');
  assert.equal(llamacpp.fromEnv({ LLAMA_ARG_HOST: 'gpu-box.example.test', LLAMA_ARG_PORT: '9000' }), 'http://gpu-box.example.test:9000');
});

test("Unload is refused for a llama.cpp server that isn't a router", async () => {
  const r = await llamacpp.act({ model: 'gemma' }, 'unload');
  assert.equal(r.ok, false);
});
