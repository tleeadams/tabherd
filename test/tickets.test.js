'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// tickets.json goes in a folder of its own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-tickets-'));
process.env.TABHERD_DATA_DIR = path.join(home, 'data');
const trackers = require('../lib/trackers');
const tickets = require('../lib/tickets');

const SESSION = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const OTHER = '9e8d7c6b-5a49-4382-9716-05f4e3d2c1b0';

// ABC-1's description, as Jira Cloud gives it: Atlassian Document Format.
const ADF = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Steps' }] },
    {
      type: 'orderedList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Open ' }, { type: 'text', text: 'the login page', marks: [{ type: 'link', attrs: { href: 'https://example.com/login' } }] }] }] },
        {
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Sign in as ' }, { type: 'mention', attrs: { id: 'u1', text: '@Ada' } }] },
            { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'with 2FA' }] }] }] },
          ],
        },
      ],
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'It fails with:' }, { type: 'hardBreak' }, { type: 'text', text: 'a blank page. See ' }, { type: 'text', text: 'https://example.com/a', marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }] }] },
    { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'screenshot', type: 'file' } }] },
    { type: 'codeBlock', attrs: { language: 'text' }, content: [{ type: 'text', text: 'TypeError: x is undefined' }] },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Seen in Safari too' }] }] },
  ],
};

// Jira, Linear and Zendesk, answering as their documentation says.
function standIn() {
  const asked = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      asked.push({ url: req.url, body });
      const reply = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.url.startsWith('/jira/rest/api/3/issue/ABC-1?')) {
        return reply(200, { key: 'ABC-1', fields: { summary: 'Fix the login', status: { name: 'In Review', statusCategory: { key: 'indeterminate' } }, assignee: { displayName: 'Ada' }, description: ADF } });
      }
      if (req.url.startsWith('/jira/rest/api/3/issue/')) return reply(404, { errorMessages: ['Issue does not exist'] });
      // Data Center: version 2, with its description as text.
      if (req.url.startsWith('/dc/rest/api/2/issue/OPS-7?')) {
        return reply(200, { key: 'OPS-7', fields: { summary: 'Rotate the keys', status: { name: 'To Do', statusCategory: { key: 'new' } }, assignee: null, description: 'h2. Steps\r\n\r\n*Bold* text' } });
      }
      if (req.url === '/linear') {
        const { query, variables } = JSON.parse(body);
        if (variables.id === 'ENG-42') {
          const issue = { identifier: 'ENG-42', title: 'Tidy the CSS', url: 'https://linear.app/acme/issue/ENG-42/tidy', state: { name: 'Done', type: 'completed' }, assignee: null };
          return reply(200, { data: { issue: query.includes('description') ? { ...issue, description: '## Why\r\n\r\nIt is **messy**.' } : issue } });
        }
        return reply(200, { data: null, errors: [{ message: 'Entity not found: Issue', extensions: { type: 'invalid input' } }] });
      }
      if (req.url === '/zd/api/v2/tickets/4567.json') return reply(200, { ticket: { id: 4567, subject: 'Refund', status: 'pending', description: 'Please refund order 1001.' } });
      reply(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, asked, base: `http://127.0.0.1:${server.address().port}` })));
}

// gh, for issues in octo/app.
trackers.useGh(async (args) => {
  if (args[1] === 'repos/octo/app/issues/12') return { ok: true, stdout: JSON.stringify({ number: 12, title: 'Crash on start', body: 'It crashes.\r\n', state: 'closed', state_reason: 'not_planned', html_url: 'https://github.com/octo/app/issues/12', assignee: { login: 'octocat' } }) };
  if (args[1] === 'repos/octo/app/issues/13') return { ok: true, stdout: JSON.stringify({ number: 13, title: 'Add dark mode', state: 'closed', html_url: 'https://github.com/octo/app/pull/13', pull_request: { merged_at: '2026-11-01T00:00:00Z' } }) };
  return { ok: false, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
});

// A repository, on a branch named for ABC-1, whose origin is octo/app.
function repo() {
  const dir = path.join(home, 'app');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/abc-1-fix-login\n');
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/octo/app.git\n');
  return dir;
}

test("each tracker's ticket is read, with its status in the dashboard's groups", async () => {
  const s = await standIn();
  trackers.endpoints.linear = `${s.base}/linear`;
  try {
    const jira = { id: '11111111-1111-4111-8111-111111111111', type: 'jira', name: 'Jira', url: `${s.base}/jira`, email: 'me@example.com', token: 't', prefixes: [] };
    assert.deepEqual(await trackers.read(jira, 'ABC-1'), {
      ok: true,
      ticket: { key: 'ABC-1', title: 'Fix the login', status: 'In Review', category: 'progress', assignee: 'Ada', url: `${s.base}/jira/browse/ABC-1` },
    });
    assert.deepEqual(await trackers.read(jira, 'ABC-2'), { ok: false, missing: true });
    const linear = { id: '22222222-2222-4222-8222-222222222222', type: 'linear', name: 'Linear', token: 'lin', prefixes: [] };
    assert.equal((await trackers.read(linear, 'ENG-42')).ticket.category, 'done');
    assert.equal(JSON.parse(s.asked.find((a) => a.url === '/linear').body).variables.id, 'ENG-42', 'the key is a variable, not in the query');
    assert.deepEqual(await trackers.read(linear, 'ENG-1'), { ok: false, missing: true });
    const zd = { id: '33333333-3333-4333-8333-333333333333', type: 'zendesk', name: 'Zendesk', url: `${s.base}/zd`, email: 'me@example.com', token: 'z', prefixes: [] };
    assert.deepEqual((await trackers.read(zd, '#4567')).ticket, { key: '#4567', title: 'Refund', status: 'Pending', category: 'progress', assignee: null, url: `${s.base}/zd/agent/tickets/4567` });
    const gh = { id: '44444444-4444-4444-8444-444444444444', type: 'github', name: 'GitHub', prefixes: [] };
    assert.equal((await trackers.read(gh, 'octo/app#12')).ticket.category, 'closed', 'closed as not planned');
    assert.deepEqual((await trackers.read(gh, 'octo/app#13')).ticket.pullRequest, true);
    assert.deepEqual(await trackers.read(gh, 'octo/app#99'), { ok: false, missing: true });
    assert.deepEqual(await trackers.read(gh, '--help/x#1'), { ok: false, missing: true }, 'only a key that could be one goes to gh');
  } finally {
    s.server.close();
  }
});

test('a session is linked to the tickets its branch, claims and links name, where they exist', async () => {
  const s = await standIn();
  trackers.endpoints.linear = `${s.base}/linear`;
  const list = [
    { id: '11111111-1111-4111-8111-111111111111', type: 'jira', name: 'Work Jira', url: `${s.base}/jira`, email: 'me@example.com', token: 't', prefixes: ['ABC'] },
    { id: '22222222-2222-4222-8222-222222222222', type: 'linear', name: 'Linear', url: '', email: '', token: 'lin', prefixes: [] },
    { id: '33333333-3333-4333-8333-333333333333', type: 'zendesk', name: 'Support', url: `${s.base}/zd`, email: 'me@example.com', token: 'z', prefixes: [] },
    { id: '44444444-4444-4444-8444-444444444444', type: 'github', name: 'GitHub', url: '', email: '', token: '', prefixes: [] },
  ];
  tickets.useTrackers(() => list);
  try {
    const claims = [
      { op: 'claim', key: 'ENG-42', hint: null },
      { op: 'claim', key: '#4567', hint: 'support' },
      { op: 'claim', key: '#12', hint: null },
      { op: 'claim', key: 'ENG-7', hint: null },
    ];
    const session = () => ({ app: 'claude', id: SESSION, cwd: repo(), ticketRefs: claims });
    let a = session();
    tickets.observe([a]);
    assert.equal('ticketRefs' in a, false, "what the transcript found isn't sent to the page");
    await tickets.settled();
    a = session();
    tickets.observe([a]);
    assert.deepEqual(
      a.tickets.map((t) => [t.trackerName, t.key, t.status]),
      [
        ['Work Jira', 'ABC-1', 'In Review'],
        ['Linear', 'ENG-42', 'Done'],
        ['Support', '#4567', 'Pending'],
        ['GitHub', 'octo/app#12', 'Not planned'],
      ],
      "ABC-1 from the branch, only in Jira, which has it; ENG-7 nowhere; #12 in the session's repository",
    );
    assert.ok(!s.asked.some((a) => a.url.includes('/jira/rest/api/3/issue/ENG-')), "a key without Jira's prefixes isn't asked of it");

    claims.push({ op: 'unclaim', key: 'ENG-42', hint: null });
    a = session();
    tickets.observe([a]);
    assert.ok(!a.tickets.some((t) => t.key === 'ENG-42'), 'Unclaim takes it off');

    assert.deepEqual(tickets.remove(SESSION, a.tickets[0].id), { ok: true });
    a = session();
    tickets.observe([a]);
    assert.ok(!a.tickets.some((t) => t.key === 'ABC-1'), 'taken off by hand, it stays off, though the branch names it');

    const added = await tickets.add({ id: SESSION, cwd: repo() }, 'octo/app#13, ABC-404, https://linear.app/acme/issue/ENG-42');
    assert.deepEqual(added, { ok: true, linked: ['octo/app#13', 'ENG-42'], notFound: ['ABC-404'], unsure: [] });
    a = session();
    tickets.observe([a]);
    assert.ok(a.tickets.some((t) => t.key === 'ENG-42'), 'linked by hand again after Unclaim');
    assert.match((await tickets.add({ id: SESSION, cwd: repo() }, 'the login bug')).error, /Paste a ticket/);

    // Another session in the same folder isn't linked to these claims.
    const other = { app: 'codex', id: OTHER, cwd: repo(), ticketRefs: [] };
    tickets.observe([other]);
    assert.deepEqual(
      other.tickets.map((t) => t.key),
      ['ABC-1'],
      'only its branch',
    );
  } finally {
    s.server.close();
    tickets.useTrackers(() => []);
  }
});

test('what a session claimed is kept, so a transcript read again changes nothing', () => {
  const r = { claims: [], manual: [], dropped: [], removed: [] };
  const ops = [
    { op: 'claim', key: 'ABC-1', hint: null },
    { op: 'claim', key: 'ABC-2', hint: null },
    { op: 'unclaim', key: 'ABC-1', hint: null },
  ];
  tickets.apply(r, ops);
  const once = JSON.stringify(r);
  tickets.apply(r, ops);
  assert.equal(JSON.stringify(r), once);
  assert.deepEqual(
    r.claims.map((x) => x.key),
    ['ABC-2'],
  );
  assert.deepEqual(r.dropped, ['ABC-1']);
});

test('a to-do is linked to the tickets it was given, not its folder’s branch', async () => {
  const s = await standIn();
  // A tracker of its own, so nothing is known from the tests before.
  const list = [{ id: '55555555-5555-4555-8555-555555555555', type: 'jira', name: 'Jira', url: `${s.base}/jira`, email: 'me@example.com', token: 't', prefixes: [] }];
  tickets.useTrackers(() => list);
  try {
    const todo = { cwd: repo(), ticketRefs: tickets.parse(`${s.base}/jira/browse/ABC-1, OPS-5`) };
    assert.deepEqual(tickets.forTodo(todo), [], 'not looked up yet');
    await tickets.settled();
    assert.deepEqual(
      tickets.forTodo(todo).map((x) => x.key),
      ['ABC-1'],
      'from a link on its tracker; OPS-5 is in none',
    );
    assert.deepEqual(tickets.forTodo({ cwd: repo(), ticketRefs: [] }), [], "its folder is on ABC-1's branch, but it starts its own");
  } finally {
    s.server.close();
    tickets.useTrackers(() => []);
  }
});

test('a ticket pasted as a new to-do’s title fills it in, with its description', async () => {
  const s = await standIn();
  trackers.endpoints.linear = `${s.base}/linear`;
  const list = [
    { id: '66666666-6666-4666-8666-666666666666', type: 'jira', name: 'Jira', url: `${s.base}/jira`, email: 'me@example.com', token: 't', prefixes: ['ABC'] },
    { id: '77777777-7777-4777-8777-777777777777', type: 'jira', name: 'Data Center', url: `${s.base}/dc`, email: '', token: 'pat', prefixes: ['OPS'] },
    { id: '88888888-8888-4888-8888-888888888888', type: 'linear', name: 'Linear', token: 'lin', prefixes: ['ENG'] },
    { id: '99999999-9999-4999-8999-999999999999', type: 'zendesk', name: 'Zendesk', url: `${s.base}/zd`, email: 'me@example.com', token: 'z', prefixes: [] },
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'github', name: 'GitHub', prefixes: [] },
  ];
  tickets.useTrackers(() => list);
  try {
    const link = `${s.base}/jira/browse/ABC-1`;
    assert.deepEqual(await tickets.describe(link), {
      ok: true,
      ticket: {
        key: 'ABC-1',
        title: 'Fix the login',
        description: [
          'Steps',
          '1. Open the login page (https://example.com/login)\n2. Sign in as @Ada\n   - with 2FA',
          'It fails with:\na blank page. See https://example.com/a',
          '```\nTypeError: x is undefined\n```',
          '> Seen in Safari too',
        ].join('\n\n'),
        trackerName: 'Jira',
      },
    });
    assert.ok(s.asked.some((a) => a.url.endsWith('?fields=summary,status,assignee,description')), 'its description is asked for');
    assert.deepEqual(
      tickets.forTodo({ cwd: null, ticketRefs: tickets.parse(link) }).map((x) => x.key),
      ['ABC-1'],
      'its chip shows at once',
    );
    assert.equal((await tickets.describe('OPS-7')).ticket.description, 'h2. Steps\n\n*Bold* text', "Data Center's is text already");
    assert.equal((await tickets.describe('https://linear.app/acme/issue/ENG-42/tidy')).ticket.description, '## Why\n\nIt is **messy**.');
    assert.equal((await tickets.describe('octo/app#12')).ticket.description, 'It crashes.');
    // A Zendesk link has the ticket straight after the address.
    assert.deepEqual((await tickets.describe(`${s.base}/agent/tickets/4567`)).ticket, { key: '#4567', title: 'Refund', description: 'Please refund order 1001.', trackerName: 'Zendesk' });
    for (const text of ['Fix the login', 'https://example.com/docs', '12', '#12', 'ABC-1 and more']) {
      assert.deepEqual(await tickets.describe(text), { ok: true, ticket: null }, `${text} isn't one ticket`);
    }
    assert.deepEqual(await tickets.describe('ABC-2'), { ok: false, error: "That ticket wasn't found in your trackers." });
    tickets.useTrackers(() => []);
    assert.deepEqual(await tickets.describe('ABC-1'), { ok: false, error: 'Add your trackers in Settings → Tickets first.' });
  } finally {
    s.server.close();
    tickets.useTrackers(() => []);
  }
});

test('a long ticket is cut to fit a to-do', async () => {
  const long = 'x'.repeat(30000);
  trackers.useGh(async () => ({ ok: true, stdout: JSON.stringify({ number: 5, title: `A ${'very '.repeat(60)}long title`, body: long, state: 'open' }) }));
  tickets.useTrackers(() => [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', type: 'github', name: 'GitHub', prefixes: [] }]);
  try {
    const { ticket } = await tickets.describe('octo/app#5');
    assert.equal(ticket.title.length, 200);
    assert.ok(ticket.title.endsWith('…'));
    assert.equal(ticket.description.length, 20000);
  } finally {
    tickets.useTrackers(() => []);
  }
});
