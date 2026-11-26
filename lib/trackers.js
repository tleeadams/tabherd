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

// Jira Cloud's API is version 3. Data Center, signed in with a personal
// access token rather than an email, has version 2.
const jiraApi = (t) => (t.email ? '/rest/api/3' : '/rest/api/2');
const refused = (status) => status === 401 || status === 403;

// Asks a Jira site, at the address that takes its token. A refused request
// did nothing, so it's safe to send again through the gateway.
async function jiraCall(t, route, { method = 'GET', body } = {}) {
  const known = jiraBases.get(jiraKey(t));
  const options = { method, headers: { Authorization: jiraAuth(t) }, body };
  if (known) return request(`${known}${jiraApi(t)}${route}`, options);
  let base = t.url;
  let answer = await request(`${base}${jiraApi(t)}${route}`, options);
  if (refused(answer.status) && t.email) {
    // A scoped token is refused at the site's own address.
    const tenant = await request(`${t.url}/_edge/tenant_info`);
    if (tenant.data?.cloudId && /^[0-9a-f-]{36}$/i.test(tenant.data.cloudId)) {
      const gateway = `${endpoints.atlassian}/ex/jira/${tenant.data.cloudId}`;
      const through = await request(`${gateway}${jiraApi(t)}${route}`, options);
      if (!refused(through.status)) [base, answer] = [gateway, through];
    }
  }
  // Signed in, whether or not what was asked for is there.
  if ([200, 201, 204, 404].includes(answer.status)) jiraBases.set(jiraKey(t), base);
  return answer;
}

const jiraGet = (t, route) => jiraCall(t, route);

const jiraMyself = (t) => jiraGet(t, '/myself');

// Runs gh; tests swap it for a stand-in.
let gh = (args) =>
  new Promise((resolve) => {
    execFile('gh', args, { timeout: REQUEST_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, missing: err.code === 'ENOENT', stdout: '', stderr: String(stderr || '') } : { ok: true, stdout });
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

// ---- reading tickets ------------------------------------------------------------

// Each tracker's statuses, in the dashboard's groups: to do, in progress,
// done, and closed without being done.
const JIRA_CATEGORY = { new: 'todo', indeterminate: 'progress', done: 'done' };
const LINEAR_STATE = { triage: 'todo', backlog: 'todo', unstarted: 'todo', started: 'progress', completed: 'done', canceled: 'closed', duplicate: 'closed' };
const ZENDESK_STATUS = { new: 'todo', open: 'progress', pending: 'progress', hold: 'progress', solved: 'done', closed: 'done' };
const KEY = /^[A-Z][A-Z0-9_]{0,19}-[1-9]\d{0,8}$/;
const GITHUB = /^([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9._-]{1,100})#([1-9]\d{0,8})$/;
const NUMBER = /^#([1-9]\d{0,9})$/;
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const missing = { ok: false, missing: true };
const signInRefused = { ok: false, auth: true, error: 'It refused the sign-in. Check its token.' };
const answered = (name, status) => ({ ok: false, error: `${name} answered ${status}.` });

async function readJira(t, key) {
  if (!KEY.test(key)) return missing;
  const r = await jiraGet(t, `/issue/${encodeURIComponent(key)}?fields=summary,status,assignee`);
  if (r.status === 404) return missing;
  if (refused(r.status)) return signInRefused;
  if (r.status !== 200 || !r.data?.key) return answered('Jira', r.status);
  const f = r.data.fields || {};
  return {
    ok: true,
    ticket: {
      key: r.data.key,
      title: f.summary || '',
      status: f.status?.name || '',
      category: JIRA_CATEGORY[f.status?.statusCategory?.key] || 'progress',
      assignee: f.assignee?.displayName || null,
      url: `${t.url}/browse/${r.data.key}`,
    },
  };
}

async function readLinear(t, key) {
  if (!KEY.test(key)) return missing;
  const query = 'query($id: String!) { issue(id: $id) { identifier title url state { name type } assignee { name } } }';
  const r = await request(endpoints.linear, { method: 'POST', headers: { Authorization: t.token }, body: { query, variables: { id: key } } });
  const issue = r.data?.data?.issue;
  if (r.status === 200 && issue?.identifier) {
    return {
      ok: true,
      ticket: {
        key: issue.identifier,
        title: issue.title || '',
        status: issue.state?.name || '',
        category: LINEAR_STATE[issue.state?.type] || 'progress',
        assignee: issue.assignee?.name || null,
        url: typeof issue.url === 'string' && issue.url.startsWith('https://linear.app/') ? issue.url : null,
      },
    };
  }
  const errors = (r.data?.errors || []).map((e) => `${e.message || ''} ${e.extensions?.type || ''}`).join(' ');
  if (refused(r.status) || /authenticat/i.test(errors)) return signInRefused;
  if (/not found/i.test(errors)) return missing;
  return answered('Linear', r.status);
}

async function readGitHub(key) {
  const m = key.match(GITHUB);
  if (!m) return missing;
  const r = await gh(['api', `repos/${m[1]}/${m[2]}/issues/${m[3]}`]);
  if (r.missing) return { ok: false, error: "GitHub's command-line tool, gh, isn't installed. Get it from cli.github.com." };
  if (!r.ok) {
    if (/HTTP (404|410)|Not Found/i.test(r.stderr || '')) return missing;
    if (/HTTP 401|gh auth login|authentication/i.test(r.stderr || '')) return { ok: false, auth: true, error: "gh isn't signed in. Run gh auth login." };
    return { ok: false, error: "gh couldn't read it." };
  }
  let d;
  try {
    d = JSON.parse(r.stdout);
  } catch {
    return { ok: false, error: "gh couldn't read it." };
  }
  // A pull request's number answers as an issue too.
  const pull = Boolean(d.pull_request);
  const done = pull ? Boolean(d.pull_request.merged_at) : d.state_reason !== 'not_planned';
  return {
    ok: true,
    ticket: {
      key: `${m[1]}/${m[2]}#${m[3]}`,
      title: d.title || '',
      status: d.state === 'open' ? 'Open' : pull ? (done ? 'Merged' : 'Closed') : done ? 'Closed' : 'Not planned',
      category: d.state === 'open' ? 'progress' : done ? 'done' : 'closed',
      assignee: d.assignee?.login || null,
      url: `https://github.com/${m[1]}/${m[2]}/${pull ? 'pull' : 'issues'}/${m[3]}`,
      pullRequest: pull,
    },
  };
}

async function readZendesk(t, key) {
  const m = key.match(NUMBER);
  if (!m) return missing;
  const auth = t.auth === 'oauth' ? `Bearer ${t.token}` : basic(`${t.email}/token`, t.token);
  const r = await request(`${t.url}/api/v2/tickets/${m[1]}.json`, { headers: { Authorization: auth } });
  if (r.status === 404) return missing;
  if (refused(r.status)) return signInRefused;
  const z = r.data?.ticket;
  if (r.status !== 200 || !z?.id) return answered('Zendesk', r.status);
  return {
    ok: true,
    ticket: {
      key: `#${z.id}`,
      title: z.subject || '',
      status: capital(z.status || ''),
      category: ZENDESK_STATUS[z.status] || 'progress',
      assignee: null,
      url: `${t.url}/agent/tickets/${z.id}`,
    },
  };
}

// One ticket from one tracker: { ok: true, ticket: { key, title, status,
// category, assignee, url } }; { ok: false, missing: true } when the tracker
// says there's no such ticket; else { ok: false, error }, with auth: true if
// the sign-in was refused. Nothing in an error comes from the token.
async function read(t, key) {
  try {
    if (t.type === 'github') return await readGitHub(key);
    if (!t.token) return { ok: false, auth: true, error: 'Set its token first.' };
    if (t.type === 'jira') return await readJira(t, key);
    if (t.type === 'linear') return await readLinear(t, key);
    if (t.type === 'zendesk') return await readZendesk(t, key);
    return missing;
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? "It didn't answer in time." : "Couldn't reach it." };
  }
}

// ---- writing back -----------------------------------------------------------------

// What a write answers when the tracker won't let it, or fails.
const cantWrite = { ok: false, error: 'It refused: check that its token can write.' };
const failed = (status) => (refused(status) ? cantWrite : { ok: false, error: `It answered ${status}.` });
const zendeskAuth = (t) => (t.auth === 'oauth' ? `Bearer ${t.token}` : basic(`${t.email}/token`, t.token));

// A comment for Jira Cloud, in Atlassian Document Format: its paragraphs,
// with line breaks and links kept.
function adf(text) {
  const inline = (paragraph) => {
    const nodes = [];
    paragraph.split('\n').forEach((line, i) => {
      if (i) nodes.push({ type: 'hardBreak' });
      let at = 0;
      for (const m of line.matchAll(/https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]/g)) {
        if (m.index > at) nodes.push({ type: 'text', text: line.slice(at, m.index) });
        nodes.push({ type: 'text', text: m[0], marks: [{ type: 'link', attrs: { href: m[0] } }] });
        at = m.index + m[0].length;
      }
      if (at < line.length) nodes.push({ type: 'text', text: line.slice(at) });
    });
    return nodes;
  };
  const paragraphs = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/).filter((p) => p.trim());
  return { type: 'doc', version: 1, content: paragraphs.map((p) => ({ type: 'paragraph', content: inline(p.trim()) })) };
}

const LINEAR_DONE_STATES = 'query($id: String!) { issue(id: $id) { id team { states(filter: { type: { eq: "completed" } }) { nodes { id name position } } } } }';

async function linear(t, query, variables) {
  const r = await request(endpoints.linear, { method: 'POST', headers: { Authorization: t.token }, body: { query, variables } });
  const errors = (r.data?.errors || []).map((e) => e.message || '').join(' ');
  if (refused(r.status) || /authenticat|forbidden|permission/i.test(errors)) return { ...cantWrite, data: null };
  if (r.status !== 200 || errors) return { ok: false, error: errors ? `Linear: ${errors.slice(0, 200)}` : `It answered ${r.status}.`, data: null };
  return { ok: true, data: r.data.data };
}

// The ways to move a ticket to done: [{ id, name }]. Jira's are the
// transitions from its status into one that's done, which depend on its
// workflow; Linear's, its team's completed states. GitHub closes an issue as
// completed, and Zendesk solves a ticket.
async function doneMoves(t, key) {
  try {
    if (t.type === 'github') return { ok: true, moves: [{ id: 'completed', name: 'Close as completed' }] };
    if (t.type === 'zendesk') return { ok: true, moves: [{ id: 'solved', name: 'Solved' }] };
    if (!KEY.test(key)) return missing;
    if (t.type === 'jira') {
      const r = await jiraGet(t, `/issue/${encodeURIComponent(key)}/transitions`);
      if (r.status !== 200) return failed(r.status);
      const moves = (r.data?.transitions || []).filter((x) => x.to?.statusCategory?.key === 'done').map((x) => ({ id: String(x.id), name: x.name || x.to?.name || '' }));
      return { ok: true, moves };
    }
    if (t.type === 'linear') {
      const r = await linear(t, LINEAR_DONE_STATES, { id: key });
      if (!r.ok) return r;
      const nodes = r.data?.issue?.team?.states?.nodes || [];
      return { ok: true, moves: [...nodes].sort((a, b) => a.position - b.position).map((s) => ({ id: s.id, name: s.name })) };
    }
    return missing;
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? "It didn't answer in time." : "Couldn't reach it." };
  }
}

// Comments on a ticket and moves it to done, as asked: { comment, publicReply,
// move }, where move is one of doneMoves()' IDs. Answers { ok, done }, where
// done lists what was done before anything failed: 'comment', 'move'.
async function write(t, key, { comment = null, publicReply = false, move = null } = {}) {
  const done = [];
  const fail = (r) => ({ ...r, done });
  try {
    if (t.type === 'github') {
      const m = key.match(GITHUB);
      if (!m) return fail(missing);
      const issue = `repos/${m[1]}/${m[2]}/issues/${m[3]}`;
      if (comment) {
        const r = await gh(['api', '-X', 'POST', `${issue}/comments`, '-f', `body=${comment}`]);
        if (!r.ok) return fail({ ok: false, error: r.missing ? "GitHub's command-line tool, gh, isn't installed. Get it from cli.github.com." : "gh couldn't post the comment." });
        done.push('comment');
      }
      if (move) {
        const r = await gh(['api', '-X', 'PATCH', issue, '-f', 'state=closed', '-f', 'state_reason=completed']);
        if (!r.ok) return fail({ ok: false, error: "gh couldn't close it." });
        done.push('move');
      }
      return { ok: true, done };
    }
    if (!t.token) return fail({ ok: false, auth: true, error: 'Set its token first.' });
    if (t.type === 'jira') {
      if (!KEY.test(key)) return fail(missing);
      const issue = `/issue/${encodeURIComponent(key)}`;
      if (comment) {
        // Cloud takes a document; Data Center, plain text.
        const r = await jiraCall(t, `${issue}/comment`, { method: 'POST', body: { body: t.email ? adf(comment) : comment } });
        if (r.status !== 201 && r.status !== 200) return fail(failed(r.status));
        done.push('comment');
      }
      if (move) {
        const r = await jiraCall(t, `${issue}/transitions`, { method: 'POST', body: { transition: { id: String(move) } } });
        if (r.status !== 204 && r.status !== 200) return fail(failed(r.status));
        done.push('move');
      }
      return { ok: true, done };
    }
    if (t.type === 'linear') {
      if (!KEY.test(key)) return fail(missing);
      const found = await linear(t, 'query($id: String!) { issue(id: $id) { id } }', { id: key });
      const issueId = found.data?.issue?.id;
      if (!found.ok || !issueId) return fail(found.ok ? missing : found);
      if (comment) {
        const r = await linear(t, 'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId, body: comment } });
        if (!r.ok || !r.data?.commentCreate?.success) return fail(r.ok ? { ok: false, error: "Linear didn't take the comment." } : r);
        done.push('comment');
      }
      if (move) {
        const r = await linear(t, 'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: issueId, input: { stateId: String(move) } });
        if (!r.ok || !r.data?.issueUpdate?.success) return fail(r.ok ? { ok: false, error: "Linear didn't move it." } : r);
        done.push('move');
      }
      return { ok: true, done };
    }
    if (t.type === 'zendesk') {
      const m = key.match(NUMBER);
      if (!m) return fail(missing);
      // One request does both. A comment is an internal note unless it's a
      // public reply, which emails the requester, as solving does.
      const ticket = {};
      if (comment) ticket.comment = { body: comment, public: Boolean(publicReply) };
      if (move) ticket.status = 'solved';
      if (!Object.keys(ticket).length) return { ok: true, done };
      const r = await request(`${t.url}/api/v2/tickets/${m[1]}.json`, { method: 'PUT', headers: { Authorization: zendeskAuth(t) }, body: { ticket } });
      if (r.status !== 200) return fail(failed(r.status));
      if (comment) done.push('comment');
      if (move) done.push('move');
      return { ok: true, done };
    }
    return fail(missing);
  } catch (err) {
    return fail({ ok: false, error: err.name === 'TimeoutError' ? "It didn't answer in time." : "Couldn't reach it." });
  }
}

module.exports = { TYPES, clean, cleanList, forPage, save, remove, test, read, doneMoves, write, adf, endpoints, useGh };
