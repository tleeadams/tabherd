'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A home folder with the default Claude Code folder, another account's, and
// a ~/.claude-* folder Claude Code never used.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-home-'));
for (const dir of ['.claude/sessions', '.claude-work/sessions', '.claude-notes']) fs.mkdirSync(path.join(home, dir), { recursive: true });
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-claude-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.CLAUDE_CONFIG_DIR;
const claudeDirs = require('../lib/claude-dirs');
const terminals = require('../lib/terminals');

test('only the default folder is watched until Settings adds more', () => {
  assert.equal(claudeDirs.DEFAULT, path.join(home, '.claude'));
  assert.deepEqual(claudeDirs.list(), [claudeDirs.DEFAULT]);
});

test('other ~/.claude-* folders that Claude Code used are offered', () => {
  assert.deepEqual(claudeDirs.others(), [path.join(home, '.claude-work')], 'not one without sessions or projects');
});

test('chosen folders are watched after the default, each once, and only while they exist', () => {
  const work = path.join(home, '.claude-work');
  claudeDirs.configure([work, elsewhere, work, path.join(home, 'gone'), 'relative']);
  assert.deepEqual(claudeDirs.list(), [claudeDirs.DEFAULT, work, elsewhere]);
  assert.equal(claudeDirs.watched(work), work);
  assert.equal(claudeDirs.watched(work.replace(/\\/g, '/')), work, 'however its path is written');
  assert.equal(claudeDirs.watched(path.join(home, 'gone')), claudeDirs.DEFAULT, 'a folder not watched resumes with the default');
  assert.equal(claudeDirs.label(work), '.claude-work');
  claudeDirs.configure([]);
});

test('a tab command sets the Claude Code folder in the shell it runs in', () => {
  const cmd = terminals.withEnv('CLAUDE_CONFIG_DIR', "/home/me/.claude-o'brien", 'claude --resume x');
  if (process.platform === 'win32') assert.equal(cmd, "$env:CLAUDE_CONFIG_DIR = '/home/me/.claude-o''brien'; claude --resume x");
  else assert.equal(cmd, "CLAUDE_CONFIG_DIR='/home/me/.claude-o'\\''brien' claude --resume x");
});
