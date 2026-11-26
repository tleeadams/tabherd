'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { icon, versionInfo } = require('../scripts/launcher');
const { encode, decode } = require('../scripts/png');
const { SIZES, iconFile } = require('../scripts/icons');

const ROOT = path.join(__dirname, '..');

// public/app.js runs only in the browser, so nothing else would catch a
// syntax error in it.
test('every script parses', () => {
  const files = ['server.js', ...['lib', 'public', 'scripts', 'test'].flatMap((dir) =>
    fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f)),
  )];
  for (const file of files) execFileSync(process.execPath, ['--check', path.join(ROOT, file)]);
});

test('the rulesets and code owners are well formed', () => {
  const dir = path.join(ROOT, '.github', 'rulesets');
  const rulesets = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.equal(new Set(rulesets.map((r) => r.name)).size, rulesets.length, 'names are unique, as the setup matches on them');
  const named = (name) => rulesets.find((r) => r.name === name);
  const pr = named('Reviews').rules.find((r) => r.type === 'pull_request').parameters;
  assert.ok(pr.required_approving_review_count >= 1 && pr.require_code_owner_review, 'a code owner has to approve');
  // The admin can skip waiting for CI and reviews when merging a pull request,
  // and nothing else: not the branch rules, not the tags, not direct pushes.
  const adminMerging = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }];
  for (const name of ['CI', 'Reviews']) assert.deepEqual(named(name).bypass_actors, adminMerging, name);
  for (const name of ['Gitflow', "Release tags can't change"]) assert.deepEqual(named(name).bypass_actors, [], name);
  assert.equal(rulesets.length, 4, 'every ruleset is checked above');
  const owners = fs.readFileSync(path.join(ROOT, '.github', 'CODEOWNERS'), 'utf8');
  assert.match(owners, /^\* @[\w-]+/m, 'every file has an owner');
});

test('release notes come from the changelog, with either line ending', () => {
  const { releaseNotes } = require('../scripts/build-release');
  const changelog = '# Changelog\n\n## 0.2.0 - 2026-12-01\n\n- New.\n\n## 0.1.0 - 2026-11-19\n\n- First.\n';
  assert.equal(releaseNotes(changelog, '0.2.0'), '- New.\n');
  assert.equal(releaseNotes(changelog, '0.1.0'), '- First.\n');
  assert.equal(releaseNotes(changelog.replace(/\n/g, '\r\n'), '0.1.0'), '- First.\n');
  assert.throws(() => releaseNotes(changelog, '0.3.0'), /no notes under "## 0\.3\.0"/);
});

// The desktop app takes its version from package.json, but its crate has one
// too, which a release sets by hand.
test("the desktop app's crate has package.json's version", () => {
  const { version } = require('../package.json');
  const cargo = (file) => fs.readFileSync(path.join(ROOT, 'app', 'src-tauri', file), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(/^version = "([^"]+)"/m.exec(cargo('Cargo.toml'))[1], version, 'Cargo.toml');
  assert.equal(/^name = "tabherd"\nversion = "([^"]+)"/m.exec(cargo('Cargo.lock'))[1], version, 'Cargo.lock');
});

test('PNGs are read back as they were written', () => {
  const rgba = Buffer.from(Array.from({ length: 3 * 2 * 4 }, (_, i) => (i * 37) % 256));
  const back = decode(encode(3, 2, rgba));
  assert.deepEqual([back.width, back.height], [3, 2]);
  assert.deepEqual([...back.rgba], [...rgba]);
});

test('the icons are made from the logo, with clear corners, at every size', () => {
  for (const size of SIZES) {
    const { width, height, rgba } = decode(fs.readFileSync(iconFile(size)));
    assert.deepEqual([width, height], [size, size]);
    assert.equal(rgba[3], 0, `the ${size}px corner is transparent`);
    const middle = ((size >> 1) * size + (size >> 1)) * 4 + 3;
    assert.equal(rgba[middle], 255, `the ${size}px middle is solid`);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'favicon.svg'), 'utf8'), /data:image\/png;base64,/);
});

test("the launcher's icon holds each size", () => {
  const ico = icon([16, 32, 256]);
  assert.equal(ico.readUInt16LE(2), 1, 'an icon file');
  assert.equal(ico.readUInt16LE(4), 3, 'three images');
  assert.deepEqual([ico[6], ico[22], ico[38]], [16, 32, 0], '256 is written as 0');
});

test("the launcher's file details carry the version, in numbers where they have to be", () => {
  const info = versionInfo('0.2.0-beta.1');
  assert.match(info, /AssemblyProduct\("Tabherd"\)/);
  assert.match(info, /AssemblyFileVersion\("0\.2\.0\.0"\)/);
  assert.match(info, /AssemblyInformationalVersion\("0\.2\.0-beta\.1"\)/);
  assert.throws(() => versionInfo('1.0'), /Not a version/);
});
