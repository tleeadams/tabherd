#!/usr/bin/env node
'use strict';

// Adds Tabherd to the desktop on macOS and Linux, as the Windows launcher's
// --install does there, and removes it again with --uninstall:
//
// - Linux: an entry in the applications menu, with its icon
// - macOS: Tabherd.app in ~/Applications, which opens the dashboard
// - both: a `tabherd` command, as a link in ~/.local/bin
//
// The release's `tabherd` script runs it:
//   node scripts/desktop-entry.js --install|--uninstall <path to the tabherd script>

const fs = require('fs');
const os = require('os');
const path = require('path');
const { iconFile } = require('./icons');
const { version } = require('../package.json');

const HOME = os.homedir();
const BIN = path.join(HOME, '.local', 'bin', 'tabherd');
const DESKTOP = path.join(HOME, '.local', 'share', 'applications', 'tabherd.desktop');
const ICON = path.join(HOME, '.local', 'share', 'icons', 'hicolor', '256x256', 'apps', 'tabherd.png');
const MAC_APP = path.join(HOME, 'Applications', 'Tabherd.app');

const pngIcon = (size) => fs.readFileSync(iconFile(size));

// An .icns file holding PNG images at the sizes macOS uses.
function icns() {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  };
  const body = Buffer.concat([
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
  ].map(([type, size]) => chunk(type, pngIcon(size))));
  return chunk('icns', body);
}

// A path in a .desktop file's Exec line, quoted as its spec asks.
const desktopQuote = (s) => `"${s.replace(/["`$\\]/g, (c) => `\\${c}`)}"`;
const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function write(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, mode ? { mode } : undefined);
  if (mode) fs.chmodSync(file, mode);
}

// The `tabherd` link, unless something else already has that name.
function linkCommand(script, done) {
  let existing = null;
  try {
    existing = fs.lstatSync(BIN);
  } catch {}
  if (existing && !existing.isSymbolicLink()) {
    done.push(`left ${BIN} alone: it isn't a link Tabherd made`);
    return;
  }
  if (existing) fs.unlinkSync(BIN);
  fs.mkdirSync(path.dirname(BIN), { recursive: true });
  fs.symlinkSync(script, BIN);
  done.push(BIN);
  const onPath = (process.env.PATH || '').split(':').includes(path.dirname(BIN));
  if (!onPath) done.push(`(${path.dirname(BIN)} isn't on your PATH, so add it to run \`tabherd\` from anywhere)`);
}

function install(script) {
  const done = [];
  if (process.platform === 'darwin') {
    const contents = path.join(MAC_APP, 'Contents');
    write(
      path.join(contents, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Tabherd</string>
  <key>CFBundleIdentifier</key><string>io.github.tleeadams.tabherd</string>
  <key>CFBundleExecutable</key><string>Tabherd</string>
  <key>CFBundleIconFile</key><string>Tabherd</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${xmlEscape(version)}</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`,
    );
    // The app only starts the script, which opens the dashboard and ends, so
    // it stays out of the Dock.
    write(path.join(contents, 'MacOS', 'Tabherd'), `#!/bin/sh\nexec ${shQuote(script)}\n`, 0o755);
    write(path.join(contents, 'Resources', 'Tabherd.icns'), icns());
    done.push(MAC_APP);
  } else {
    write(ICON, pngIcon(256));
    write(
      DESKTOP,
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Tabherd',
        'Comment=A dashboard for your coding agents',
        `Exec=${desktopQuote(script)}`,
        `Icon=${ICON}`,
        'Terminal=false',
        'Categories=Development;',
        '',
      ].join('\n'),
    );
    done.push(DESKTOP);
  }
  linkCommand(script, done);
  console.log(`Added:\n  ${done.join('\n  ')}`);
}

function uninstall() {
  const done = [];
  const remove = (file) => {
    if (!fs.existsSync(file) && !isLink(file)) return;
    fs.rmSync(file, { recursive: true, force: true });
    done.push(file);
  };
  remove(MAC_APP);
  remove(DESKTOP);
  remove(ICON);
  if (isLink(BIN)) remove(BIN);
  console.log(done.length ? `Removed:\n  ${done.join('\n  ')}` : 'There was nothing to remove.');
}

function isLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function main() {
  const [action, script] = process.argv.slice(2);
  if (process.platform === 'win32') throw new Error('On Windows, use Tabherd.exe --install.');
  if (action === '--install') {
    if (!script || !fs.existsSync(script)) throw new Error('Give the path of the tabherd script.');
    install(path.resolve(script));
  } else if (action === '--uninstall') uninstall();
  else throw new Error('Use --install or --uninstall.');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { icns };
