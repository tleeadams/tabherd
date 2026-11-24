#!/usr/bin/env node
'use strict';

// Gets app/src-tauri ready to build: Node as the app's sidecar, named for the
// Rust target as Tauri wants it, and the app's icons from public/icons.
//
//   node scripts/stage-app.js                    for this computer, with the Node running this
//   node scripts/stage-app.js --target <triple>  for that Rust target, such as aarch64-apple-darwin
//   node scripts/stage-app.js --node <path>      bundles that node executable
//
// Then, in app/src-tauri: `cargo build` for a debug build to try, or
// `cargo tauri build` for the installer.

const fs = require('fs');
const path = require('path');
const { icon } = require('./launcher');
const { iconFile } = require('./icons');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app', 'src-tauri');
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

function option(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

function stage() {
  const target = option('--target') || TARGETS[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`No Rust target for ${process.platform}-${process.arch}; give one with --target.`);
  const node = option('--node') || process.execPath;
  const exe = target.includes('windows') ? '.exe' : '';
  const binaries = path.join(APP, 'binaries');
  fs.mkdirSync(binaries, { recursive: true });
  const sidecar = path.join(binaries, `node-${target}${exe}`);
  fs.copyFileSync(node, sidecar);
  if (!exe) fs.chmodSync(sidecar, 0o755);

  const icons = path.join(APP, 'icons');
  fs.mkdirSync(icons, { recursive: true });
  fs.writeFileSync(path.join(icons, 'icon.ico'), icon(ICON_SIZES));
  fs.copyFileSync(iconFile(512), path.join(icons, 'icon.png'));
  console.log(`Staged ${path.relative(ROOT, sidecar)} from ${node}, and the icons.`);
}

stage();
