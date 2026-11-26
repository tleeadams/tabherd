'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

process.env.TABHERD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-write-'));
const trackers = require('../lib/trackers');
const tickets = require('../lib/tickets');

// Jira, Linear and Zendesk, answering writes as their documentation says,
// and keeping what they were sent.
function standIn() {
  const asked = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const sent = body ? JSON.parse(body) : null;
      asked.push({ method: req.method, url: req.url, sent });
      const reply = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      if (req.url === '/jira/rest/api/3/issue/ABC-1/transitions' && req.method === 'GET') {
        return reply(200, {
          transitions: [
            { id: '21', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
            { id: '31', name: 'Finish', to: { name: 'Done', statusCategory: { key: 'done' } } },
          ],
        });
      }
      if (req.url === '/jira/rest/api/3/issue/ABC-1/comment') return reply(201, { id: '100' });
      if (req.url === '/jira/rest/api/3/issue/ABC-1/transitions') return sent.transition.id === '31' ? reply(204) : reply(400, {});
      if (req.url === '/jira/rest/api/3/issue/ABC-2/comment') return reply(403, {});
      if (req.url === '/linear') {
        if (sent.query.includes('states(')) return reply(200, { data: { issue: { id: 'issue-uuid', team: { states: { nodes: [{ id: 'state-b', name: 'Shipped', position: 2 }, { id: 'state-a', name: 'Done', position: 1 }] } } } } });
        if (sent.query.includes('commentCreate')) return reply(200, { data: { commentCreate: { success: true } } });
        if (sent.query.includes('issueUpdate')) return reply(200, { data: { issueUpdate: { success: true } } });
        return reply(200, { data: { issue: { id: 'issue-uuid' } } });
      }
      if (req.url === '/zd/api/v2/tickets/4567.json' && req.method === 'PUT') return reply(200, { ticket: { id: 4567 } });
      reply(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, asked, base: `http://127.0.0.1:${server.address().port}` })));
}

const ghCalls = [];
trackers.useGh(async (args) => {
  ghCalls.push(args);
  return { ok: true, stdout: '{}' };
});

const tracker = (type, base, more = {}) => ({ id: `${type.padEnd(8, type[0]).slice(0, 8)}-1111-4111-8111-111111111111`, type, name: type, url: '', email: '', token: 'tok', prefixes: [], ...more });

test("Jira's comment is a document with its links, and only its transitions into done are offered", () => {
  assert.deepEqual(trackers.adf('Done in a Claude Code session (Login): fixed.\n\nPull requests: https://github.com/octo/app/pull/7, https://github.com/octo/app/pull/8'), {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Done in a Claude Code session (Login): fixed.' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Pull requests: ' },
          { type: 'text', text: 'https://github.com/octo/app/pull/7', marks: [{ type: 'link', attrs: { href: 'https://github.com/octo/app/pull/7' } }] },
          { type: 'text', text: ', ' },
          { type: 'text', text: 'https://github.com/octo/app/pull/8', marks: [{ type: 'link', attrs: { href: 'https://github.com/octo/app/pull/8' } }] },
        ],
      },
    ],
  });
});

test('each tracker is written to as its documentation says', async () => {
  const s = await standIn();
  trackers.endpoints.linear = `${s.base}/linear`;
  try {
    const jira = tracker('jira', s.base, { url: `${s.base}/jira`, email: 'me@example.com' });
    assert.deepEqual(await trackers.doneMoves(jira, 'ABC-1'), { ok: true, moves: [{ id: '31', name: 'Finish' }] });
    assert.deepEqual(await trackers.write(jira, 'ABC-1', { comment: 'Done: https://example.com/x', move: '31' }), { ok: true, done: ['comment', 'move'] });
    const comment = s.asked.find((a) => a.url.endsWith('/ABC-1/comment')).sent.body;
    assert.equal(comment.type, 'doc');
    assert.deepEqual(s.asked.find((a) => a.method === 'POST' && a.url.endsWith('/ABC-1/transitions')).sent, { transition: { id: '31' } });
    assert.deepEqual(await trackers.write(jira, 'ABC-2', { comment: 'x' }), { ok: false, error: 'It refused: check that its token can write.', done: [] }, 'a token that can only read');
    const half = await trackers.write(jira, 'ABC-1', { comment: 'again', move: '21' });
    assert.deepEqual(half, { ok: false, error: 'It answered 400.', done: ['comment'] }, 'what was done before it failed is said, so it isn’t done twice');

    const linear = tracker('linear', s.base);
    assert.deepEqual(await trackers.doneMoves(linear, 'ENG-42'), {
      ok: true,
      moves: [
        { id: 'state-a', name: 'Done' },
        { id: 'state-b', name: 'Shipped' },
      ],
    }, "the team's completed states, in order");
    assert.deepEqual(await trackers.write(linear, 'ENG-42', { comment: '**Done**', move: 'state-a' }), { ok: true, done: ['comment', 'move'] });
    const sentToLinear = s.asked.filter((a) => a.url === '/linear').map((a) => a.sent.variables);
    assert.deepEqual(sentToLinear.find((v) => v.input?.body), { input: { issueId: 'issue-uuid', body: '**Done**' } });
    assert.deepEqual(sentToLinear.find((v) => v.input?.stateId), { id: 'issue-uuid', input: { stateId: 'state-a' } });

    const zd = tracker('zendesk', s.base, { url: `${s.base}/zd`, email: 'me@example.com' });
    assert.deepEqual(await trackers.write(zd, '#4567', { comment: 'Fixed', move: 'solved' }), { ok: true, done: ['comment', 'move'] });
    assert.deepEqual(s.asked.find((a) => a.method === 'PUT').sent, { ticket: { comment: { body: 'Fixed', public: false }, status: 'solved' } }, 'an internal note unless it’s a public reply');

    const gh = tracker('github', s.base);
    assert.deepEqual(await trackers.write(gh, 'octo/app#12', { comment: 'Fixed in #13', move: 'completed' }), { ok: true, done: ['comment', 'move'] });
    assert.deepEqual(ghCalls, [
      ['api', '-X', 'POST', 'repos/octo/app/issues/12/comments', '-f', 'body=Fixed in #13'],
      ['api', '-X', 'PATCH', 'repos/octo/app/issues/12', '-f', 'state=closed', '-f', 'state_reason=completed'],
    ]);
  } finally {
    s.server.close();
  }
});

test("Complete's writes go only to the tickets on the session's card", async () => {
  const s = await standIn();
  const jira = tracker('jira', s.base, { url: `${s.base}/jira`, email: 'me@example.com' });
  tickets.useTrackers(() => [jira]);
  try {
    const chip = { id: `${jira.id} ABC-1`, tracker: jira.id, type: 'jira', key: 'ABC-1', category: 'progress' };
    const done = { ...chip, id: `${jira.id} ABC-3`, key: 'ABC-3', category: 'done' };
    const pr = { id: 'x octo/app#9', tracker: jira.id, key: 'ABC-9', pullRequest: true, category: 'progress' };
    const agent = { id: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', tickets: [chip, done, pr] };
    const options = await tickets.doneOptions(agent);
    assert.deepEqual(
      options.tickets.map((o) => [o.chip, o.moves.length]),
      [
        [chip.id, 1],
        [done.id, 0],
        [pr.id, 0],
      ],
      'one already done, or a pull request, isn’t moved',
    );
    const r = await tickets.writeBack(agent, [
      { chip: chip.id, comment: 'Done.', move: '31' },
      { chip: `${jira.id} OPS-1`, comment: 'Not on the card' },
      { chip: pr.id, move: '31' },
    ]);
    assert.deepEqual(r.results, [
      { chip: chip.id, ok: true, error: null, done: ['comment', 'move'] },
      { chip: `${jira.id} OPS-1`, ok: false, error: 'That ticket is no longer on its card.', done: [] },
      { chip: pr.id, ok: true, error: null, done: [] },
    ]);
    assert.ok(!s.asked.some((a) => a.url.includes('OPS-1') || a.url.includes('ABC-9')), 'nothing sent for those');
  } finally {
    s.server.close();
    tickets.useTrackers(() => []);
  }
});
