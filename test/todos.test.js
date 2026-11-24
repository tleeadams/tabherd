'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TABHERD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-test-'));
const todos = require('../lib/todos');

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

test('a to-do is cleaned up and checked', () => {
  const made = todos.create({ title: '  Fix   the   thing ', notes: 'one\r\ntwo\n\n' });
  assert.ok(made.ok);
  assert.equal(made.todo.title, 'Fix the thing');
  assert.equal(made.todo.notes, 'one\ntwo');
  assert.equal(todos.create({ title: '   ' }).ok, false);
  assert.equal(todos.create({ title: 'x'.repeat(201) }).ok, false);
  assert.equal(todos.edit(made.todo.id, { title: '' }).ok, false);
  assert.ok(todos.edit(made.todo.id, { title: 'Fix it', notes: 'n' }).ok);
  assert.equal(todos.find(made.todo.id).title, 'Fix it');
  assert.ok(todos.remove(made.todo.id).ok);
  assert.equal(todos.find(made.todo.id), null);
});

test('a started to-do follows its session until it closes, and comes back on resume', () => {
  const { todo } = todos.create({ title: 'Ship it' });
  const id = todo.id;
  todos.setFolder(id, os.tmpdir());
  todos.started(id, ID1);
  const startedAt = todos.find(id).startedAt;

  assert.equal(todos.pending(startedAt + 1000)[0].starting, true);
  assert.equal(todos.pending(startedAt + 61000)[0].starting, false, 'stops waiting after a minute');

  // The session appears and is asked something: the to-do moves onto its card.
  let agents = [{ id: ID1, pid: 42, startedAt: 500, prompts: 1 }];
  todos.observe(agents, 1000);
  assert.equal(agents[0].todo.title, 'Ship it');
  assert.equal(todos.pending(1000).length, 0);
  assert.ok(todos.isLive(id));

  // /clear gives the same process a new session ID.
  agents = [{ id: ID2, pid: 42, startedAt: 500, prompts: 1 }];
  todos.observe(agents, 2000);
  assert.ok(agents[0].todo);
  assert.equal(todos.find(id).sessionId, ID2);

  // The process is gone; another one reusing its PID isn't linked.
  agents = [{ id: '33333333-3333-4333-8333-333333333333', pid: 42, startedAt: 999 }];
  todos.observe(agents, 3000);
  assert.equal(agents[0].todo, undefined);
  assert.equal(todos.find(id).closedAt, 3000);
  assert.equal(todos.isLive(id), false);
  assert.equal(todos.pending(3000).length, 0, 'a closed to-do has no card');

  // Resumed, with the same session ID in a new process.
  agents = [{ id: ID2, pid: 77, startedAt: 4000, prompts: 1 }];
  todos.observe(agents, 4000);
  assert.ok(agents[0].todo);
  assert.equal(todos.find(id).closedAt, null);

  // Closed again, and dropped after 30 days.
  todos.observe([], 5000);
  todos.observe([], 5000 + 31 * 24 * 60 * 60 * 1000);
  assert.equal(todos.find(id), null);
});

test('a session closed before it was asked anything gives its to-do back', () => {
  const { todo } = todos.create({ title: 'Not yet' });
  todos.setFolder(todo.id, os.tmpdir());
  todos.started(todo.id, '44444444-4444-4444-8444-444444444444');
  const agents = [{ id: '44444444-4444-4444-8444-444444444444', pid: 90, startedAt: 6000, prompts: 0 }];
  todos.observe(agents, 6000);
  assert.ok(agents[0].todo, 'it hands over as usual');
  assert.equal(todos.pending(6000).some((t) => t.id === todo.id), false);

  todos.observe([], 7000);
  const back = todos.pending(7000).find((t) => t.id === todo.id);
  assert.ok(back, 'it has its own card again');
  assert.equal(back.cwd, os.tmpdir(), 'with its folder kept');
  assert.equal(back.startedAt, null, 'ready to start, not "no session yet"');
  assert.equal(todos.find(todo.id).closedAt, null);
});

test('to-dos are saved to disk', () => {
  const { todo } = todos.create({ title: 'Saved' });
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.TABHERD_DATA_DIR, 'todos.json'), 'utf8'));
  assert.ok(saved.todos.some((t) => t.id === todo.id && t.title === 'Saved'));
});

test("a to-do can name the app it starts in, and a Codex one is linked once its session starts", () => {
  const { todo } = todos.create({ title: 'Try it in Codex', app: 'codex' });
  assert.equal(todo.app, 'codex');
  assert.equal(todos.create({ title: 'Anything', app: 'bash' }).todo.app, null, 'only Claude or Codex, else as in Settings');
  todos.started(todo.id, null);
  assert.ok(todos.pending(Date.now()).find((t) => t.id === todo.id).starting, 'waiting for Codex to start');
  const session = '01900000-0000-7000-8000-0000000000c1';
  todos.linked(todo.id, session);
  // A Codex session whose window isn't known has no PID.
  const agent = { id: session, pid: null, startedAt: 1, prompts: 0, app: 'codex' };
  todos.observe([agent], Date.now());
  assert.equal(agent.todo.title, 'Try it in Codex', 'on its session card');
  assert.ok(!todos.pending(Date.now()).some((t) => t.id === todo.id));
});

test('a Codex to-do whose session closes unused comes back to start again', () => {
  const { todo } = todos.create({ title: 'Closed unused', app: 'codex' });
  const session = '01900000-0000-7000-8000-0000000000c2';
  todos.started(todo.id, null);
  todos.linked(todo.id, session);
  todos.observe([{ id: session, pid: null, startedAt: 1, prompts: 0, app: 'codex' }], Date.now());
  assert.ok(todos.isLive(todo.id));
  todos.observe([], Date.now());
  assert.ok(!todos.isLive(todo.id));
  const back = todos.pending(Date.now()).find((t) => t.id === todo.id);
  assert.ok(back && !back.startedAt, 'its own card again, ready to start');
});
