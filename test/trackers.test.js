'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const trackers = require('../lib/trackers');

const JIRA = { type: 'jira', name: 'Work Jira', url: 'https://example.atlassian.net', email: 'me@example.com', token: 'jira-token', prefixes: ['abc', 'OPS'] };

test('a tracker is saved cleaned, and its token is kept unless replaced', () => {
  let r = trackers.save([], JIRA);
  assert.equal(r.ok, true);
  const saved = r.tracker;
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(saved.prefixes, ['ABC', 'OPS']);
  r = trackers.save(r.list, { ...saved, name: 'Renamed', token: undefined });
  assert.equal(r.list[0].token, 'jira-token', 'left out, the token is kept');
  assert.equal(r.list[0].name, 'Renamed');
  r = trackers.save(r.list, { ...saved, token: '' });
  assert.equal(r.list[0].token, '', 'empty clears it');
  assert.deepEqual(trackers.forPage(r.list)[0].tokenSet, false);
  assert.ok(!('token' in trackers.forPage(r.list)[0]), 'the page never gets a token');
  assert.deepEqual(trackers.remove(r.list, saved.id), []);
});

test('what a tracker needs is checked', () => {
  assert.match(trackers.save([], { ...JIRA, url: 'http://example.atlassian.net' }).error, /address/, 'https, except on this computer');
  assert.equal(trackers.save([], { ...JIRA, url: 'http://127.0.0.1:9000' }).ok, true);
  assert.match(trackers.save([], { ...JIRA, url: 'https://user:pw@example.atlassian.net' }).error, /address/);
  assert.match(trackers.save([], { ...JIRA, prefixes: ['1AB'] }).error, /prefixes/);
  assert.match(trackers.save([], { ...JIRA, name: ' ' }).error, /name/);
  assert.match(trackers.save([], { ...JIRA, type: 'trello' }).error, /Jira, Linear/);
  const gh = trackers.save([], { type: 'github', name: 'GitHub', token: 'ignored', prefixes: ['X'], url: 'https://x' }).tracker;
  assert.deepEqual([gh.token, gh.url, gh.prefixes], ['', '', []], "GitHub uses gh's sign-in, and repositories name themselves");
});

// A stand-in for Jira, Atlassian's gateway, Linear and Zendesk at once,
// answering as their documentation says.
function standIn() {
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push({ url: req.url, auth: req.headers.authorization });
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const basicJira = `Basic ${Buffer.from('me@example.com:jira-token').toString('base64')}`;
    // Jira: a classic token works at the site; a scoped one only through the gateway.
    if (req.url === '/site/rest/api/3/myself') return req.headers.authorization === basicJira ? reply(200, { displayName: 'Ada' }) : reply(401, {});
    if (req.url === '/scoped/rest/api/3/myself') return reply(401, {});
    if (req.url === '/scoped/_edge/tenant_info') return reply(200, { cloudId: '22222222-2222-4222-8222-222222222222' });
    if (req.url === '/gw/ex/jira/22222222-2222-4222-8222-222222222222/rest/api/3/myself') return reply(200, { displayName: 'Scoped Ada' });
    if (req.url === '/linear') return req.headers.authorization === 'lin_api_ok' ? reply(200, { data: { viewer: { name: 'Lin' } } }) : reply(400, { errors: [{}] });
    // Zendesk answers a refused sign-in with an anonymous user.
    if (req.url === '/zd/api/v2/users/me.json') {
      const ok = req.headers.authorization === `Basic ${Buffer.from('me@example.com/token:zd-token').toString('base64')}` || req.headers.authorization === 'Bearer zd-oauth';
      return reply(200, { user: ok ? { id: 7, name: 'Zed' } : { id: null, name: 'Anonymous user' } });
    }
    reply(404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, asked, base: `http://127.0.0.1:${server.address().port}` })));
}

test('Test signs in to each system and says as whom', async () => {
  const s = await standIn();
  trackers.endpoints.linear = `${s.base}/linear`;
  trackers.endpoints.atlassian = `${s.base}/gw`;
  try {
    const t = (fields) => trackers.save([], fields).tracker;
    assert.deepEqual(await trackers.test(t({ ...JIRA, url: `${s.base}/site` })), { ok: true, as: 'Ada' });
    assert.deepEqual(await trackers.test(t({ ...JIRA, url: `${s.base}/site`, token: 'wrong' })), { ok: false, error: 'Jira refused the sign-in. Check the email and API token.' });
    assert.deepEqual(await trackers.test(t({ ...JIRA, url: `${s.base}/scoped` })), { ok: true, as: 'Scoped Ada' }, 'a scoped token goes through the gateway');
    assert.deepEqual(await trackers.test(t({ type: 'linear', name: 'L', token: 'lin_api_ok' })), { ok: true, as: 'Lin' });
    assert.equal(s.asked.find((a) => a.url === '/linear').auth, 'lin_api_ok', "Linear's key goes as it is, no Bearer");
    assert.equal((await trackers.test(t({ type: 'linear', name: 'L', token: 'bad' }))).ok, false);
    const zd = { type: 'zendesk', name: 'Z', url: `${s.base}/zd`, email: 'me@example.com', token: 'zd-token' };
    assert.deepEqual(await trackers.test(t(zd)), { ok: true, as: 'Zed' });
    assert.deepEqual(await trackers.test(t({ ...zd, auth: 'oauth', token: 'zd-oauth' })), { ok: true, as: 'Zed' });
    assert.equal((await trackers.test(t({ ...zd, token: 'bad' }))).ok, false, 'an anonymous answer is a refusal');
    assert.equal((await trackers.test(t({ ...JIRA, token: '' }))).error, 'Set its token first.');
    const errors = JSON.stringify(await Promise.all([trackers.test(t({ ...JIRA, url: `${s.base}/site`, token: 'secret-wrong' }))]));
    assert.ok(!errors.includes('secret-wrong'), 'no token in an error');
  } finally {
    s.server.close();
  }
});

test("GitHub's Test asks gh, and says what to do if it can't", async () => {
  const gh = trackers.save([], { type: 'github', name: 'GitHub' }).tracker;
  trackers.useGh(async () => ({ ok: true, stdout: 'octocat\n' }));
  assert.deepEqual(await trackers.test(gh), { ok: true, as: 'octocat' });
  trackers.useGh(async () => ({ ok: false, stdout: '' }));
  assert.match((await trackers.test(gh)).error, /gh auth login/);
  trackers.useGh(async () => ({ ok: false, missing: true, stdout: '' }));
  assert.match((await trackers.test(gh)).error, /cli\.github\.com/);
});
