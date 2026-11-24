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
    assert.deepEqual(model.actions, ['open', 'unload']);
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
