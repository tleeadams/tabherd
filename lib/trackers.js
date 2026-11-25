'use strict';

const crypto = require('crypto');
const { execFile } = require('child_process');

// Ticket trackers: Jira sites, Linear, GitHub Issues and Zendesk, each with
// its sign-in. They're kept in settings.json, encrypted, and set in
// Settings → Tickets. A token never goes back to the page. See
// docs/ticket-links.md.

const TYPES = ['jira', 'linear', 'github', 'zendesk'];
const MAX_TRACKERS = 20;
const MAX_PREFIXES = 50;
const REQUEST_MS = 10000;
// Where Linear's API and Atlassian's gateway for scoped Jira tokens are.
// Tests point them at stand-ins.
const endpoints = { linear: 'https://api.linear.app/graphql', atlassian: 'https://api.atlassian.com' };

const text = (value, max) => (typeof value === 'string' && value.length <= max && !/[\r\n]/.test(value) ? value.trim() : undefined);

// An https address, or http on this computer, without a login in it.
function address(value) {
  const v = text(value, 500)?.replace(/\/+$/, '');
  if (!v) return undefined;
  try {
    const u = new URL(v);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    return (u.protocol === 'https:' || (u.protocol === 'http:' && local)) && !u.username && !u.password && !u.search && !u.hash ? v : undefined;
  } catch {
    return undefined;
  }
}

// ABC, OPS: a project or team key's letters, upper case.
function prefixes(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > MAX_PREFIXES) return undefined;
  const out = [];
  for (const p of list) {
    const v = typeof p === 'string' ? p.trim().toUpperCase() : '';
    if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(v)) return undefined;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// A tracker as saved, or undefined if it isn't valid.
function clean(t) {
  if (!t || typeof t !== 'object' || !TYPES.includes(t.type)) return undefined;
  const id = typeof t.id === 'string' && /^[0-9a-f-]{36}$/i.test(t.id) ? t.id : undefined;
  const name = text(t.name, 60);
  const token = t.token === undefined ? '' : text(t.token, 4000);
  const email = t.email === undefined ? '' : text(t.email, 200);
  const list = prefixes(t.prefixes);
  if (!id || !name || token === undefined || email === undefined || !list) return undefined;
  const needsAddress = t.type === 'jira' || t.type === 'zendesk';
  const url = needsAddress ? address(t.url) : '';
  if (url === undefined) return undefined;
  return {
    id,
    type: t.type,
    name,
    url,
    // Jira and Zendesk sign in with an email and token. Without an email, a
    // Jira token is a Data Center personal access token.
    email: t.type === 'jira' || t.type === 'zendesk' ? email : '',
    // Zendesk: an API token, or an OAuth access token.
    auth: t.type === 'zendesk' && t.auth === 'oauth' ? 'oauth' : 'token',
    prefixes: t.type === 'github' ? [] : list,
    // GitHub uses gh's own sign-in.
    token: t.type === 'github' ? '' : token,
  };
}

function cleanList(list) {
  if (!Array.isArray(list) || list.length > MAX_TRACKERS) return undefined;
  const out = list.map(clean);
  return out.includes(undefined) ? undefined : out;
}

// What the page may see: everything but the token, which only says if it's set.
const forPage = (list) => list.map(({ token, ...t }) => ({ ...t, tokenSet: Boolean(token) }));

const ERRORS = {
  type: 'Choose Jira, Linear, GitHub Issues or Zendesk.',
  name: 'Give it a name, of up to 60 characters.',
  url: 'Give its address, such as https://example.atlassian.net.',
  prefixes: 'Key prefixes are letters and digits, starting with a letter, such as ABC.',
  full: `There can be at most ${MAX_TRACKERS} trackers.`,
};

// The list with one tracker added or changed. A token left out is kept; an
// empty one is cleared.
function save(list, incoming) {
  if (!incoming || typeof incoming !== 'object' || !TYPES.includes(incoming.type)) return { ok: false, error: ERRORS.type };
  const old = list.find((t) => t.id === incoming.id);
  if (!old && list.length >= MAX_TRACKERS) return { ok: false, error: ERRORS.full };
  const merged = { ...incoming, id: old ? old.id : crypto.randomUUID(), token: incoming.token === undefined ? old?.token || '' : incoming.token };
  const tracker = clean(merged);
  if (!tracker) {
    if (!text(merged.name, 60)) return { ok: false, error: ERRORS.name };
    if (!prefixes(merged.prefixes)) return { ok: false, error: ERRORS.prefixes };
    if ((merged.type === 'jira' || merged.type === 'zendesk') && !address(merged.url)) return { ok: false, error: ERRORS.url };
    return { ok: false, error: 'Not a valid tracker.' };
  }
  return { ok: true, tracker, list: old ? list.map((t) => (t.id === old.id ? tracker : t)) : [...list, tracker] };
}

const remove = (list, id) => list.filter((t) => t.id !== id);

// ---- signing in ----------------------------------------------------------------

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_MS),
    redirect: 'error',
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

function jiraAuth(t) {
  return t.email ? basic(t.email, t.token) : `Bearer ${t.token}`;
}

// The base address that takes this tracker's token: the site, or for a
// scoped Cloud token, Atlassian's gateway with the site's cloud ID. Kept per
// tracker and token, so it's found once.
const jiraBases = new Map();
const jiraKey = (t) => `${t.id}:${crypto.createHash('sha256').update(`${t.url} ${t.email} ${t.token}`).digest('hex')}`;

async function jiraMyself(t) {
  const known = jiraBases.get(jiraKey(t));
  const headers = { Authorization: jiraAuth(t) };
  const bases = known ? [known] : [t.url];
  let answer = await request(`${bases[0]}/rest/api/3/myself`, { headers });
  if (!known && (answer.status === 401 || answer.status === 403) && t.email) {
    // A scoped token is refused at the site's own address.
    const tenant = await request(`${t.url}/_edge/tenant_info`);
    if (tenant.data?.cloudId && /^[0-9a-f-]{36}$/i.test(tenant.data.cloudId)) {
      const gateway = `${endpoints.atlassian}/ex/jira/${tenant.data.cloudId}`;
      answer = await request(`${gateway}/rest/api/3/myself`, { headers });
      if (answer.status === 200) bases[0] = gateway;
    }
  }
  if (answer.status === 200) jiraBases.set(jiraKey(t), bases[0]);
  return answer;
}

// Runs gh; tests swap it for a stand-in.
let gh = (args) =>
  new Promise((resolve) => {
    execFile('gh', args, { timeout: REQUEST_MS, windowsHide: true }, (err, stdout) => {
      resolve(err ? { ok: false, missing: err.code === 'ENOENT', stdout: '' } : { ok: true, stdout });
    });
  });
const useGh = (fn) => {
  gh = fn;
};

// Signs in and says as whom: { ok, as } or { ok: false, error }. Nothing in an
// error comes from the token.
async function test(t) {
  try {
    if (t.type === 'github') {
      const r = await gh(['api', 'user', '--jq', '.login']);
      if (r.missing) return { ok: false, error: "GitHub's command-line tool, gh, isn't installed. Get it from cli.github.com." };
      if (!r.ok || !r.stdout.trim()) return { ok: false, error: "gh isn't signed in. Run gh auth login." };
      return { ok: true, as: r.stdout.trim() };
    }
    if (!t.token) return { ok: false, error: 'Set its token first.' };
    if (t.type === 'jira') {
      const r = await jiraMyself(t);
      if (r.status === 200) return { ok: true, as: r.data?.displayName || r.data?.emailAddress || 'you' };
      if (r.status === 401 || r.status === 403) return { ok: false, error: 'Jira refused the sign-in. Check the email and API token.' };
      return { ok: false, error: `Jira answered ${r.status}. Check the site's address.` };
    }
    if (t.type === 'linear') {
      const r = await request(endpoints.linear, { method: 'POST', headers: { Authorization: t.token }, body: { query: '{ viewer { name } }' } });
      if (r.status === 200 && r.data?.data?.viewer) return { ok: true, as: r.data.data.viewer.name || 'you' };
      return { ok: false, error: 'Linear refused the key. Check it in Linear → Settings → Security & access.' };
    }
    if (t.type === 'zendesk') {
      const auth = t.auth === 'oauth' ? `Bearer ${t.token}` : basic(`${t.email}/token`, t.token);
      const r = await request(`${t.url}/api/v2/users/me.json`, { headers: { Authorization: auth } });
      // Zendesk answers a refused sign-in with an anonymous user.
      if (r.status === 200 && r.data?.user?.id) return { ok: true, as: r.data.user.name || r.data.user.email || 'you' };
      if (r.status === 200 || r.status === 401 || r.status === 403) return { ok: false, error: 'Zendesk refused the sign-in. Check the email and token, and that API token access is on in Admin Center.' };
      return { ok: false, error: `Zendesk answered ${r.status}. Check the address.` };
    }
    return { ok: false, error: ERRORS.type };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? "It didn't answer in time." : "Couldn't reach it. Check the address and your connection." };
  }
}

module.exports = { TYPES, clean, cleanList, forPage, save, remove, test, endpoints, useGh };
