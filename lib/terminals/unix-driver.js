'use strict';

// The driver for macOS and Linux, built from a list of terminal backends. A
// backend knows one terminal app:
//
//   id, name            as Settings shows it
//   processNames        the terminal's own processes; "name*" matches a prefix
//   available()         installed, or running, here
//   hosts(ctx)          whether it's the terminal a session runs in, when no
//                       terminal process is among the session's ancestors
//   open(dir, command)  opens a tab, or a window where tabs can't be opened
//   focus(ctx)          selects the session's tab and brings its window forward:
//                       { ok, tab, error }
//   type(ctx, text)     types text, then Enter on its own; null, or what went wrong
//   titles(ctxs)        Map of terminal device -> the title that tab shows, for
//                       the sessions it hosts
//
// ctx describes the session's terminal: { pid, tty, chain, env }, where chain
// is the session's process and its ancestors, nearest first, and env is the
// session's environment when it can be read (Linux).

const fs = require('fs');
const unix = require('./unix');
const tmux = require('./tmux');

const TITLE_REFRESH_MS = 3000;

// The process table, environments and tmux can be stood in for by tests.
function create({ name, backends, openFolder, pickFolder, defaultTerminal, processTable = unix.processTable, environment = unix.environment, tmux: mux = tmux }) {
  const byId = new Map(backends.map((b) => [b.id, b]));

  async function context(pid, table) {
    table = table || (await processTable());
    const self = table.get(pid);
    if (!self) return null;
    return { pid, tty: self.tty, chain: unix.ancestors(table, pid), env: environment(pid), table };
  }

  // The nearest terminal above the session is the one it runs in. A terminal
  // started from another one sits under it, and inherits its environment, so
  // the first match further up, or in the environment, could be the wrong one.
  const owns = (b, p) => (b.processNames || []).some((n) => (n.endsWith('*') ? p.name.startsWith(n.slice(0, -1)) : p.name === n));
  function hostOf(ctx) {
    for (const p of ctx.chain) {
      const backend = backends.find((b) => owns(b, p));
      if (backend) return backend;
    }
    return backends.find((b) => b.hosts?.(ctx)) || null;
  }

  function terminals() {
    return backends.filter((b) => b.open).map((b) => ({ id: b.id, name: b.name, available: b.available() }));
  }

  async function open(dir, command, { terminal } = {}) {
    let backend = byId.get(terminal);
    if (!backend?.open || !backend.available()) backend = byId.get(await defaultTerminal(backends));
    if (!backend) return { ok: false, error: 'No supported terminal was found. Install one, or choose one in Settings.' };
    return backend.open(dir, command);
  }

  // Nothing is typed while the session waits on a prompt or dialog, which
  // typing could answer.
  function waiting(statusFile) {
    try {
      return JSON.parse(fs.readFileSync(statusFile, 'utf8')).status === 'waiting';
    } catch {
      return false;
    }
  }

  async function focus(pid, { send, statusFile } = {}) {
    const ctx = await context(pid);
    if (!ctx) return { ok: false, error: 'That session is no longer running.' };
    if (!ctx.tty) return { ok: false, error: 'This session has no terminal. It may be running in the background.' };

    // In tmux, tmux selects the pane and types; the terminal showing tmux is
    // then brought forward.
    const pane = await mux.findPane(ctx.tty);
    if (pane) {
      const client = await mux.select(pane);
      let raised = null;
      if (client) {
        const outer = await context(client.pid, ctx.table);
        const host = outer && hostOf(outer);
        raised = host ? await host.focus(outer) : null;
      }
      if (send) {
        if (waiting(statusFile)) return { ok: false, error: 'It started waiting on a prompt or dialog, so nothing was typed. Answer that first.' };
        const problem = await mux.type(pane, send);
        if (problem) return { ok: false, error: `Couldn't send the question: ${problem}` };
      }
      if (!client && !send) return { ok: false, error: 'Its tmux session isn\'t shown in any terminal. Attach to it with "tmux attach".' };
      return { ok: true, tab: true, terminal: raised?.ok ? `tmux in ${raised.terminal}` : 'tmux', sent: Boolean(send) };
    }

    const host = hostOf(ctx);
    if (!host) return { ok: false, error: "Tabherd doesn't know the terminal this session runs in." };
    const result = await host.focus(ctx);
    if (!result.ok) return result;
    if (send) {
      if (!host.type) return { ok: false, error: `${host.name} can't be typed into from outside. Run the session inside tmux to use Catch up.` };
      if (waiting(statusFile)) return { ok: false, error: 'It started waiting on a prompt or dialog, so nothing was typed. Answer that first.' };
      const problem = await host.type(ctx, send);
      if (problem) return { ok: false, error: `Couldn't send the question: ${problem}` };
    }
    return { ...result, terminal: host.name, sent: Boolean(send) };
  }

  // Titles are read in the background and kept by session PID.
  const titles = new Map();
  let scanning = false;
  let lastScanAt = 0;

  async function scanTitles(pids) {
    const table = await processTable();
    const byTty = new Map();
    for (const pid of pids) {
      const tty = table.get(pid)?.tty;
      if (tty) byTty.set(tty, pid);
    }
    const found = new Map();
    const take = (map) => {
      for (const [tty, title] of map) if (byTty.has(tty) && title && !found.has(tty)) found.set(tty, title);
    };
    take(await mux.titles());
    const hosted = new Map();
    for (const pid of byTty.values()) {
      const ctx = { pid, tty: table.get(pid).tty, chain: unix.ancestors(table, pid), env: environment(pid), table };
      const host = hostOf(ctx);
      if (!host?.titles || found.has(ctx.tty)) continue;
      if (!hosted.has(host)) hosted.set(host, []);
      hosted.get(host).push(ctx);
    }
    for (const [host, ctxs] of hosted) {
      try {
        take(await host.titles(ctxs));
      } catch {}
    }
    titles.clear();
    for (const [tty, pid] of byTty) {
      const title = unix.titleKey(found.get(tty));
      if (title) titles.set(pid, title);
    }
  }

  function refreshTitles(pids) {
    if (scanning || Date.now() - lastScanAt < TITLE_REFRESH_MS || !pids.length) return;
    scanning = true;
    lastScanAt = Date.now();
    scanTitles(pids)
      .catch(() => {})
      .finally(() => (scanning = false));
  }

  return {
    name,
    terminals,
    // Commands run in a POSIX shell, or are typed into the user's own one.
    quote: unix.shQuote,
    open,
    focus,
    pickFolder,
    stop: unix.stop,
    close: unix.close,
    openFolder,
    refreshTitles,
    titleFor: (pid) => titles.get(pid) || null,
  };
}

module.exports = { create };
