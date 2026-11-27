'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TABHERD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-test-'));
const statusTimes = require('../lib/status-times');
const { Transcript } = require('../lib/transcript');

const MIN = 60e3;
const saved = () => JSON.parse(fs.readFileSync(path.join(process.env.TABHERD_DATA_DIR, 'status-times.json'), 'utf8')).cards;
const split = (a) => {
  const { working, waiting, idle, queued, live } = a.times;
  return { working, waiting, idle, queued, live };
};

test('each status change closes a segment, from when the card says it changed', () => {
  const a = { app: 'codex', id: 'c1', status: 'busy', statusSince: 0 };
  statusTimes.observe([a], 2 * MIN);
  assert.deepEqual(split(a), { working: 2 * MIN, waiting: 0, idle: 0, queued: 0, live: 'working' });
  Object.assign(a, { status: 'waiting', statusSince: 3 * MIN });
  statusTimes.observe([a], 4 * MIN);
  assert.deepEqual(split(a), { working: 3 * MIN, waiting: MIN, idle: 0, queued: 0, live: 'waiting' });
  Object.assign(a, { status: 'idle', statusSince: 5 * MIN });
  statusTimes.observe([a], 9 * MIN);
  assert.deepEqual(split(a), { working: 3 * MIN, waiting: 2 * MIN, idle: 4 * MIN, queued: 0, live: 'idle' });
  assert.equal(saved().find((c) => c.id === 'c1').status, 'idle', 'saved, for a restart');
});

test('a change dated outside the open segment is taken as now', () => {
  const a = { app: 'codex', id: 'c2', status: 'busy', statusSince: 10 * MIN };
  statusTimes.observe([a], 10 * MIN);
  Object.assign(a, { status: 'idle', statusSince: 'not a time' });
  statusTimes.observe([a], 12 * MIN);
  assert.equal(a.times.working, 2 * MIN);
  assert.equal(a.times.idle, 0);
});

test('a queued job that starts shows its time in the queue', () => {
  const job = { app: 'comfy', id: 'job', status: 'queued', statusSince: 0 };
  statusTimes.observe([job], MIN);
  Object.assign(job, { status: 'busy', statusSince: 2 * MIN });
  statusTimes.observe([job], 3 * MIN);
  assert.equal(job.times.queued, 2 * MIN);
  assert.equal(job.times.working, MIN);
});

test('a loaded model has no split', () => {
  const model = { app: 'localai', id: 'model', status: 'loaded' };
  statusTimes.observe([model], 0);
  assert.equal(model.times, undefined);
});

test("a Claude session's working time is its turns less the waiting seen", () => {
  // Started at 0; one 10-minute turn ended at 20, then a turn opened at 30
  // that waited on you from 32.
  const a = {
    app: 'claude',
    id: 'claude-1',
    startedAt: 0,
    status: 'waiting',
    statusSince: 32 * MIN,
    turns: [[20 * MIN, 10 * MIN]],
    turnStartedAt: new Date(30 * MIN).toISOString(),
  };
  statusTimes.observe([a], 35 * MIN);
  assert.deepEqual(split(a), { working: 12 * MIN, waiting: 3 * MIN, idle: 20 * MIN, queued: 0, live: 'waiting' }, 'the open turn worked 2 minutes before it waited');
  Object.assign(a, { status: 'busy', statusSince: 36 * MIN });
  statusTimes.observe([a], 40 * MIN);
  assert.deepEqual(split(a), { working: 16 * MIN, waiting: 4 * MIN, idle: 20 * MIN, queued: 0, live: 'working' });
});

test("a Claude session resumed in a new run counts only this run's turns", () => {
  const a = { app: 'claude', id: 'claude-1', startedAt: 100 * MIN, status: 'idle', statusSince: 100 * MIN, turns: [[20 * MIN, 10 * MIN], [105 * MIN, 2 * MIN]], turnStartedAt: null };
  statusTimes.observe([a], 110 * MIN);
  assert.deepEqual(split(a), { working: 2 * MIN, waiting: 0, idle: 8 * MIN, queued: 0, live: 'idle' }, 'the last run’s waiting is forgotten too');
});

test('Claude transcripts keep each turn and when the open one began', () => {
  const file = path.join(process.env.TABHERD_DATA_DIR, 'session.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-11-27T10:00:00.000Z', message: { content: 'Add a sign-up page' } },
    { type: 'system', subtype: 'turn_duration', durationMs: 90000, timestamp: '2026-11-27T10:01:30.000Z' },
    { type: 'user', timestamp: '2026-11-27T10:05:00.000Z', message: { content: 'And tests for it' } },
  ];
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const t = new Transcript(file);
  t.update();
  const s = t.summary();
  assert.deepEqual(s.turns, [[Date.parse('2026-11-27T10:01:30.000Z'), 90000]]);
  assert.equal(s.turnStartedAt, '2026-11-27T10:05:00.000Z');
});
