'use strict';

// Checks the package npm would publish: packs it, checks what's in it,
// installs it in a folder of its own and runs its `tabherd` command, which
// loads the server and everything it needs to print the table of sessions.
// CI runs it, and the npm workflow before it publishes.
//
//   npm run check-package

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// What the dashboard can't run without, and what only the repository needs.
const NEEDED = ['server.js', 'launcher/npm.js', 'lib/agents.js', 'lib/store.js', 'public/index.html', 'public/app.js', 'README.md', 'LICENSE'];
const LEFT_OUT = /^(app|assets|dist|docs|scripts|test|\.github)\//;

// npm's own script when run through npm, which needs no shell on Windows, or
// else the npm on the PATH.
const npm = (args, options) =>
  process.env.npm_execpath
    ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], { encoding: 'utf8', ...options })
    : execFileSync('npm', args, { encoding: 'utf8', shell: process.platform === 'win32', ...options });

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-package-'));
  try {
    const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', dir], { cwd: ROOT }));
    const files = packed.files.map((f) => f.path.replace(/\\/g, '/'));
    const missing = NEEDED.filter((f) => !files.includes(f));
    const extra = files.filter((f) => LEFT_OUT.test(f));
    if (missing.length) throw new Error(`The package is missing ${missing.join(', ')}. Add them to "files" in package.json.`);
    if (extra.length) throw new Error(`The package has files only the repository needs: ${extra.join(', ')}`);
    console.log(`${packed.filename}: ${files.length} files, ${Math.round(packed.size / 1024)} kB`);

    const prefix = path.join(dir, 'installed');
    fs.mkdirSync(prefix);
    npm(['install', '--prefix', prefix, '--no-audit', '--no-fund', path.join(dir, packed.filename)], { cwd: prefix });
    const out = npm(['exec', '--prefix', prefix, '--', 'tabherd', '--once'], {
      cwd: prefix,
      env: { ...process.env, TABHERD_DATA_DIR: path.join(dir, 'data') },
    });
    const last = out.trim().split('\n').pop();
    if (!/running session\(s\)$/.test(last)) throw new Error(`tabherd --once printed:\n${out}`);
    console.log(`Installed, and tabherd --once ran: ${last}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(err.stderr || err.message);
  process.exit(1);
}
