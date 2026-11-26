'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, compare, superseded } = require('../scripts/prune-prereleases');

test("versions sort in Semantic Versioning's order", () => {
  const order = ['v1.2.3-alpha.2', 'v1.2.3-alpha.10', 'v1.2.3-beta', 'v1.2.3-beta.1', 'v1.2.3-rc.1', 'v1.2.3', 'v1.2.4-alpha.1', 'v1.10.0'];
  const shuffled = [...order].reverse();
  assert.deepEqual(
    shuffled.sort((a, b) => compare(parse(a), parse(b))),
    order,
  );
  assert.equal(parse('nightly'), null);
});

// Each step publishes one more, and lists the prereleases still shown.
test('each upcoming version keeps only its newest prerelease', () => {
  const releases = [];
  const publish = (tag) => {
    releases.push({ id: releases.length + 1, tag_name: tag, draft: false });
    for (const r of superseded(releases)) r.draft = true;
    return releases.filter((r) => !r.draft).map((r) => r.tag_name);
  };
  assert.deepEqual(publish('v1.2.2'), ['v1.2.2']);
  assert.deepEqual(publish('v1.2.3-alpha.3'), ['v1.2.2', 'v1.2.3-alpha.3']);
  assert.deepEqual(publish('v1.2.3-beta.1'), ['v1.2.2', 'v1.2.3-beta.1'], 'a beta hides its version\'s alpha');
  assert.deepEqual(publish('v1.2.4-alpha.1'), ['v1.2.2', 'v1.2.3-beta.1', 'v1.2.4-alpha.1'], "the next version's alpha doesn't hide this one's beta");
  assert.deepEqual(publish('v1.2.4-beta.1'), ['v1.2.2', 'v1.2.3-beta.1', 'v1.2.4-beta.1'], 'each version keeps its own');
  assert.deepEqual(publish('v1.2.3'), ['v1.2.2', 'v1.2.4-beta.1', 'v1.2.3'], 'a release hides its prereleases');
  assert.deepEqual(publish('v1.3.0-rc.1'), ['v1.2.2', 'v1.2.4-beta.1', 'v1.2.3', 'v1.3.0-rc.1']);
  assert.deepEqual(publish('v1.3.0'), ['v1.2.2', 'v1.2.3', 'v1.3.0'], 'a later release hides a version that never came out');
});

test('drafts and tags that are not versions are left alone', () => {
  const releases = [
    { id: 1, tag_name: 'v2.0.0-beta.1', draft: false },
    { id: 2, tag_name: 'v2.0.0-beta.2', draft: true },
    { id: 3, tag_name: 'latest-build', draft: false },
  ];
  assert.deepEqual(superseded(releases), [], "a draft doesn't hide what's published");
});
