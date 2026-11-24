'use strict';

// Codex runs its sessions ("threads") in one background service per
// CODEX_HOME, and the `codex` in a terminal is a window onto it. The service
// answers on a local socket, speaking JSON-RPC over a WebSocket, and
// `codex app-server proxy` relays that socket over its stdin and stdout, the
// same way on every system. This keeps one proxy running while the service
// does, and keeps a list of the sessions it has loaded and their status, which
// it pushes to every connection as it changes. It only reads: it starts,
// resumes and answers nothing, and Codex sends approval requests to the
// windows showing a session, not to a connection like this one.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const IS_WIN = process.platform === 'win32';
const RETRY_MS = [2000, 5000, 15000, 30000, 60000];
const RESYNC_MS = 30000;
const REQUEST_MS = 10000;

// ---- WebSocket frames ----------------------------------------------------------

// A text frame from the client, which must be masked.
function encodeFrame(text, opcode = 1) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  let head;
  if (payload.length < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    head = Buffer.alloc(4);
    head.writeUInt16BE(payload.length, 2);
    head[1] = 0x80 | 126;
  } else {
    head = Buffer.alloc(10);
    head.writeBigUInt64BE(BigInt(payload.length), 2);
    head[1] = 0x80 | 127;
  }
  head[0] = 0x80 | opcode;
  const body = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

// Whole frames from the front of `buf`: { frames: [{ opcode, fin, data }], rest }.
function decodeFrames(buf) {
  const frames = [];
  for (;;) {
    if (buf.length < 2) break;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    const masked = Boolean(buf[1] & 0x80);
    const mask = masked ? buf.subarray(off, off + 4) : null;
    if (masked) off += 4;
    if (buf.length < off + len) break;
    let data = buf.subarray(off, off + len);
    if (mask) data = Buffer.from(data.map((b, i) => b ^ mask[i & 3]));
    frames.push({ opcode: buf[0] & 0x0f, fin: Boolean(buf[0] & 0x80), data });
    buf = buf.subarray(off + len);
  }
  return { frames, rest: buf };
}

// ---- the service ---------------------------------------------------------------

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Whether Codex's background service is running for this CODEX_HOME. The
// proxy only connects to a running one, so Tabherd never starts it.
function serviceRunning(home = CODEX_HOME) {
  for (const name of ['daemon.pid', 'app-server.pid']) {
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(home, 'app-server-daemon', name), 'utf8'));
      if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) return true;
    } catch {}
  }
  return false;
}

// The service's own copy of Codex, so the proxy is the same version, else
// `codex` from the PATH.
function codexCommand(home = CODEX_HOME) {
  const own = path.join(home, 'packages', 'app-server-daemon', 'current', 'bin', IS_WIN ? 'codex.exe' : 'codex');
  return fs.existsSync(own) ? own : 'codex';
}

// The status Codex reports, as the dashboard's: waiting on an approval or an
// answer, working, or idle at the prompt.
function mapStatus(status) {
  const flags = status?.activeFlags || [];
  switch (status?.type) {
    case 'active':
      if (flags.includes('waitingOnApproval')) return { status: 'waiting', waitingFor: 'Approval' };
      if (flags.includes('waitingOnUserInput')) return { status: 'waiting', waitingFor: 'Your answer' };
      return { status: 'busy', waitingFor: null };
    case 'idle':
      return { status: 'idle', waitingFor: null };
    case 'systemError':
      return { status: 'idle', waitingFor: null, detail: 'Codex reported an error' };
    default:
      return null;
  }
}

class CodexClient {
  constructor({ home = CODEX_HOME, spawnProxy } = {}) {
    this.home = home;
    this.spawnProxy = spawnProxy || (() => spawn(codexCommand(home), ['app-server', 'proxy'], { stdio: 'pipe', windowsHide: true }));
    this.threads = new Map();
    this.proc = null;
    this.ready = false;
    this.failures = 0;
    this.retryAt = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.message = [];
  }

  // Called with each snapshot: connects when the service is running, and
  // returns the sessions it has loaded.
  poll() {
    if (!this.proc && Date.now() >= this.retryAt && serviceRunning(this.home)) this.connect();
    return [...this.threads.values()];
  }

  connect() {
    let proc;
    try {
      proc = this.spawnProxy();
    } catch {
      return this.lost();
    }
    this.proc = proc;
    // Nor does the proxy keep Node running by itself.
    proc.unref?.();
    for (const s of [proc.stdin, proc.stdout, proc.stderr]) s?.unref?.();
    let buf = Buffer.alloc(0);
    let upgraded = false;
    proc.on('error', () => this.lost(proc));
    proc.on('exit', () => this.lost(proc));
    proc.stdin.on('error', () => {});
    proc.stderr?.resume();
    proc.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!/^HTTP\/1\.1 101/.test(buf.subarray(0, end).toString())) return proc.kill();
        upgraded = true;
        buf = buf.subarray(end + 4);
        this.start().catch(() => proc.kill());
      }
      const { frames, rest } = decodeFrames(buf);
      buf = rest;
      for (const f of frames) this.frame(f);
    });
    const key = crypto.randomBytes(16).toString('base64');
    proc.stdin.write(
      `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  }

  // The proxy ended, or never started: forget the sessions and try again later.
  lost(proc) {
    if (proc && proc !== this.proc) return;
    clearInterval(this.resync);
    for (const { reject } of this.pending.values()) reject(new Error('Codex connection closed'));
    this.pending.clear();
    this.threads.clear();
    this.proc = null;
    this.ready = false;
    this.retryAt = Date.now() + RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)];
  }

  close() {
    const proc = this.proc;
    this.lost(proc);
    proc?.kill();
  }

  send(msg) {
    this.proc?.stdin.write(encodeFrame(JSON.stringify(msg)));
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_MS);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send({ id, method, params });
    });
  }

  frame({ opcode, fin, data }) {
    if (opcode === 9) return this.proc?.stdin.write(encodeFrame(data, 0xa));
    if (opcode === 8) return this.proc?.kill();
    if (opcode !== 1 && opcode !== 0) return;
    this.message.push(data);
    if (!fin) return;
    const text = Buffer.concat(this.message).toString('utf8');
    this.message = [];
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    // Requests from the service, such as approvals, are for the windows
    // showing the session. Answering one here could approve something.
    if (m.method && m.id !== undefined) return;
    if (m.method) return this.notify(m.method, m.params || {});
    const waiter = this.pending.get(m.id);
    if (!waiter) return;
    this.pending.delete(m.id);
    if (m.error) waiter.reject(new Error(m.error.message || 'Codex error'));
    else waiter.resolve(m.result);
  }

  async start() {
    await this.request('initialize', { clientInfo: { name: 'tabherd', title: 'Tabherd', version: require('../package.json').version } });
    this.send({ method: 'initialized' });
    this.failures = 0;
    await this.sync();
    // The open sessions are known from here on.
    this.ready = true;
    this.resync = setInterval(() => this.sync().catch(() => {}), RESYNC_MS);
    this.resync.unref?.();
  }

  // Every loaded session, read again: catches anything a notification missed.
  async sync() {
    const ids = [];
    let cursor = null;
    do {
      const page = await this.request('thread/loaded/list', cursor ? { cursor } : {});
      ids.push(...(page?.data || []));
      cursor = page?.nextCursor || null;
    } while (cursor);
    for (const id of this.threads.keys()) if (!ids.includes(id)) this.threads.delete(id);
    for (const id of ids) await this.read(id);
  }

  async read(id) {
    try {
      const r = await this.request('thread/read', { threadId: id });
      if (r?.thread) this.update(r.thread);
    } catch {}
  }

  update(t, statusChanged) {
    const old = this.threads.get(t.id);
    const at = statusChanged || (old && JSON.stringify(old.status) !== JSON.stringify(t.status)) ? Date.now() : null;
    this.threads.set(t.id, {
      ...old,
      ...t,
      statusSince: at || old?.statusSince || (t.updatedAt ? t.updatedAt * 1000 : Date.now()),
    });
  }

  notify(method, p) {
    const t = this.threads.get(p.threadId);
    switch (method) {
      case 'thread/started':
        if (p.thread?.id) this.update(p.thread);
        break;
      case 'thread/status/changed':
        if (t) this.update({ ...t, status: p.status }, true);
        else if (p.threadId) this.read(p.threadId);
        break;
      case 'thread/name/updated':
        if (t) this.threads.set(t.id, { ...t, name: p.threadName ?? null });
        break;
      case 'thread/closed':
        this.threads.delete(p.threadId);
        break;
    }
  }
}

module.exports = { CodexClient, encodeFrame, decodeFrames, mapStatus, serviceRunning, codexCommand, CODEX_HOME };
