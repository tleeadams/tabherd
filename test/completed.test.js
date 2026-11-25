'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TABHERD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-test-'));
const completed = require('../lib/completed');

const DONE = '77777777-7777-4777-8777-777777777777';
const OTHER = '88888888-8888-4888-8888-888888888888';
const saved = () => JSON.parse(fs.readFileSync(path.join(process.env.TABHERD_DATA_DIR, 'completed.json'), 'utf8')).sessions;

test('a session marked complete stays complete, and is saved', () => {
  completed.add(DONE, 4, 1000);
  assert.equal(completed.at(DONE), 1000);
  assert.equal(completed.at(OTHER), null);
  assert.deepEqual(saved(), [{ id: DONE, at: 1000, prompts: 4 }]);
  completed.add('not-a-session', 1, 2000);
  assert.equal(completed.at('not-a-session'), null, 'only session IDs are kept');
});

test('resumed, it stays complete until it is asked more', () => {
  completed.observe([{ id: DONE, prompts: 4 }]);
  assert.equal(completed.at(DONE), 1000, 'opened again to look at it');
  completed.observe([{ id: DONE, prompts: 5 }]);
  assert.equal(completed.at(DONE), null, 'asked something new, so the work goes on');
  assert.deepEqual(saved(), []);
});

test('keeping it open takes the mark off', () => {
  completed.add(OTHER, 2, 3000);
  completed.remove(OTHER);
  assert.equal(completed.at(OTHER), null);
  completed.remove(OTHER);
});
