#!/usr/bin/env node
'use strict';

// Gets app/src-tauri ready to build: Node as the app's sidecar, named for the
// Rust target as Tauri wants it, with Node's licence, and the app's icons
// from public/icons.
//
//   node scripts/stage-app.js                    for this computer, with the Node running this
//   node scripts/stage-app.js --target <triple>  for that Rust target, such as aarch64-apple-darwin
//   node scripts/stage-app.js --node <path>      bundles that node executable
//
// Then, in app/src-tauri: `cargo build` for a debug build to try, or
// `cargo tauri build` for the installer. scripts/build-release.js does all of
// it for a release.

const fs = require('fs');
const path = require('path');
const { icon } = require('./launcher');
const { iconFile } = require('./icons');

const ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app', 'src-tauri');
const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

// Node's name for each system and processor, as Rust targets.
const TARGETS = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};

// Node's licence is beside node.exe on Windows, and a folder up from bin/node
// elsewhere.
const nodeLicense = (node) => [path.join(path.dirname(node), 'LICENSE'), path.join(path.dirname(node), '..', 'LICENSE')].find((f) => fs.existsSync(f));

// A release needs Node's licence to go with it. Trying the app from the source
// with a Node that came without one, a note saying where it is will do.
function stageApp({ target = TARGETS[`${process.platform}-${process.arch}`], node = process.execPath, needLicense = false } = {}) {
  if (!target) throw new Error(`No Rust target for ${process.platform}-${process.arch}; give one with --target.`);
  const exe = target.includes('windows') ? '.exe' : '';
  const binaries = path.join(APP_DIR, 'binaries');
  fs.mkdirSync(binaries, { recursive: true });
  // Linux's packages put it in /usr/bin, where the system's own Node may be
  // as node, so it has a name of its own there.
  const name = target.includes('linux') ? 'tabherd-node' : 'node';
  const sidecar = path.join(binaries, `${name}-${target}${exe}`);
  fs.copyFileSync(node, sidecar);
  if (!exe) fs.chmodSync(sidecar, 0o755);
  const license = nodeLicense(node);
  if (!license && needLicense) throw new Error(`Node's LICENSE isn't with ${node}. Use a Node from nodejs.org.`);
  if (license) fs.copyFileSync(license, path.join(binaries, 'node-LICENSE'));
  else fs.writeFileSync(path.join(binaries, 'node-LICENSE'), "Node.js's licence: https://github.com/nodejs/node/blob/main/LICENSE\n");

  const icons = path.join(APP_DIR, 'icons');
  fs.mkdirSync(icons, { recursive: true });
  fs.writeFileSync(path.join(icons, 'icon.ico'), icon(ICON_SIZES));
  fs.copyFileSync(iconFile(512), path.join(icons, 'icon.png'));
  return sidecar;
}

if (require.main === module) {
  const option = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const node = option('--node') || process.execPath;
  const sidecar = stageApp({ target: option('--target'), node });
  console.log(`Staged ${path.relative(ROOT, sidecar)} from ${node}, Node's licence and the icons.`);
}

module.exports = { stageApp, APP_DIR, TARGETS };
