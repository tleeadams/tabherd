#!/usr/bin/env node
'use strict';

// Builds a release in dist/: the app and Node in one folder, archived, with a
// SHA-256 checksum and the release notes for this version from CHANGELOG.md.
// For Windows, an installer too.
//
//   node scripts/build-release.js                     for this computer, with the Node running this
//   node scripts/build-release.js --target <target>   for windows-x64, macos-arm64, macos-x64,
//                                                     linux-x64 or linux-arm64
//   node scripts/build-release.js --node <path>       bundles that node executable
//   node scripts/build-release.js --download-node     bundles the latest Node of the major version
//                                                     in .node-version, from nodejs.org, checked
//                                                     against its published checksums
//   node scripts/build-release.js --stage             builds the folder, not the archive
//   node scripts/build-release.js --pack              archives the folder --stage built, and for
//                                                     Windows builds the installer around its app
//   node scripts/build-release.js --checksums         writes each release file's checksum again,
//                                                     once the installer is signed
//
// The Windows release is the desktop app in app/src-tauri, built on Windows
// with Rust and Tauri's command-line tool. The release workflow builds the
// folder, has the app signed, puts it back, builds the zip and the installer,
// then has the installer signed. The macOS and Linux releases have a shell
// script for a launcher, so they're built on Linux or macOS, with Node
// downloaded for each.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { stageApp, APP_DIR } = require('./stage-app');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const { version } = require('../package.json');
const MIN_NODE = 18;
const APP_BUILT = path.join(APP_DIR, 'target', 'release');

// What the macOS and Linux releases hold. The launcher's and the build's
// source come too, as the GPL asks of anything shipped compiled.
const APP_FILES = ['server.js', 'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'lib', 'public', 'launcher/Tabherd.cs', 'launcher/tabherd.sh', 'scripts'];
// The Windows app's own source, for the same reason. The server's is in its
// server folder.
const APP_SOURCE = ['README.md', 'CHANGELOG.md', 'scripts', 'app/page', 'app/src-tauri/src', 'app/src-tauri/build.rs', 'app/src-tauri/Cargo.toml', 'app/src-tauri/Cargo.lock', 'app/src-tauri/tauri.conf.json'];

// Tauri's command-line tool: `cargo tauri` where it's installed, else its npm
// package, which needs nothing built.
function tauri(args) {
  const cargo = spawnSync('cargo', ['tauri', '--version'], { cwd: APP_DIR, stdio: 'ignore' }).status === 0;
  if (cargo) return execFileSync('cargo', ['tauri', ...args], { cwd: APP_DIR, stdio: 'inherit' });
  // npx is a .cmd on Windows, which only a shell runs.
  execFileSync('npx', ['--yes', '@tauri-apps/cli@2', ...args], { cwd: APP_DIR, stdio: 'inherit', shell: process.platform === 'win32' });
}

const windows = {
  os: 'win32',
  archive: 'zip',
  // The app, built as it's installed: Tabherd.exe and node.exe side by side,
  // the server in server/ and Node's licence in node/.
  build(stage, node) {
    stageApp({ node, needLicense: true });
    tauri(['build', '--no-bundle']);
    for (const name of ['Tabherd.exe', 'node.exe', 'server', 'node', 'LICENSE']) {
      fs.cpSync(path.join(APP_BUILT, name), path.join(stage, name), { recursive: true });
    }
    for (const rel of APP_SOURCE) fs.cpSync(path.join(ROOT, rel), path.join(stage, rel), { recursive: true });
  },
  // The installer, around the app in the folder, signed or not. Packaging
  // would otherwise mark the app with the kind of package it's in, which
  // only Tauri's updater uses, and which would break the app's signature.
  installer(stage) {
    fs.copyFileSync(path.join(stage, 'Tabherd.exe'), path.join(APP_BUILT, 'Tabherd.exe'));
    const built = path.join(APP_BUILT, 'bundle', 'nsis');
    fs.rmSync(built, { recursive: true, force: true });
    tauri(['bundle', '--no-binary-patching']);
    const setup = fs.readdirSync(built).find((name) => name.endsWith('-setup.exe'));
    if (!setup) throw new Error(`Tauri built no installer in ${path.relative(ROOT, built)}.`);
    const file = path.join(DIST, `tabherd-v${version}-windows-${this.arch}-setup.exe`);
    fs.copyFileSync(path.join(built, setup), file);
    return file;
  },
};

// macOS and Linux: the `tabherd` script, and Node in node/, laid out as
// Node's own downloads are.
const unix = (os) => ({
  os,
  archive: 'tar.gz',
  build(stage, node) {
    for (const rel of APP_FILES) fs.cpSync(path.join(ROOT, rel), path.join(stage, rel), { recursive: true });
    const script = path.join(stage, 'tabherd');
    fs.copyFileSync(path.join(ROOT, 'launcher', 'tabherd.sh'), script);
    fs.chmodSync(script, 0o755);
    bundleNode(node, path.join(stage, 'node', 'bin', 'node'), path.join(stage, 'node', 'LICENSE'));
  },
});

const TARGETS = {
  'windows-x64': { ...windows, arch: 'x64' },
  'macos-arm64': { ...unix('darwin'), arch: 'arm64' },
  'macos-x64': { ...unix('darwin'), arch: 'x64' },
  'linux-x64': { ...unix('linux'), arch: 'x64' },
  'linux-arm64': { ...unix('linux'), arch: 'arm64' },
};
const OS_NAMES = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const hostTarget = () => `${OS_NAMES[process.platform]}-${process.arch}`;

// Copies node with its licence, which has to travel with it. Node's licence
// is beside node.exe on Windows, and a folder up from bin/node elsewhere.
function bundleNode(from, to, licenseTo = path.join(path.dirname(to), 'LICENSE')) {
  const license = [path.join(path.dirname(from), 'LICENSE'), path.join(path.dirname(from), '..', 'LICENSE')].find((f) => fs.existsSync(f));
  if (!license) throw new Error(`Node's LICENSE isn't with ${from}. Use a Node from nodejs.org.`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o755);
  fs.copyFileSync(license, licenseTo);
}

// The version a bundled node reports, when it can run here.
function checkNode(file) {
  const major = Number(execFileSync(file, ['-p', 'process.versions.node'], { encoding: 'utf8' }).split('.')[0]);
  if (!(major >= MIN_NODE)) throw new Error(`${file} is Node ${major}; the app needs ${MIN_NODE} or later.`);
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

// Downloads Node for a macOS or Linux target and checks it against the
// checksums Node publishes. Resolves to the path of its bin/node.
async function downloadNode(target) {
  const major = fs.readFileSync(path.join(ROOT, '.node-version'), 'utf8').trim();
  const index = await (await fetchOk('https://nodejs.org/dist/index.json')).json();
  const release = index.find((r) => r.version.startsWith(`v${major}.`));
  if (!release) throw new Error(`nodejs.org lists no Node ${major} release.`);
  const base = `node-${release.version}-${target.os === 'darwin' ? 'darwin' : 'linux'}-${target.arch}`;
  const dist = `https://nodejs.org/dist/${release.version}/`;
  const sums = await (await fetchOk(`${dist}SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((line) => line.endsWith(`  ${base}.tar.gz`))?.split(' ')[0];
  if (!expected) throw new Error(`Node's checksums don't list ${base}.tar.gz.`);
  const data = Buffer.from(await (await fetchOk(`${dist}${base}.tar.gz`)).arrayBuffer());
  if (sha256(data) !== expected) throw new Error(`${base}.tar.gz doesn't match Node's published checksum.`);
  const dir = path.join(DIST, 'node');
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, `${base}.tar.gz`);
  fs.writeFileSync(archive, data);
  execFileSync('tar', ['-xzf', archive, '-C', dir]);
  console.log(`Node ${release.version} for ${target.os}-${target.arch}, checksum verified`);
  return path.join(dir, base, 'bin', 'node');
}

function archive(target, stage, file) {
  if (target.archive === 'zip') {
    // Windows' own tar (bsdtar) writes zips; Git's GNU tar, which may come
    // first on the PATH, doesn't.
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-a', '-c', '-f', file, '-C', path.dirname(stage), path.basename(stage)]);
  } else {
    // COPYFILE_DISABLE keeps macOS's tar from adding ._ files.
    execFileSync('tar', ['-czf', file, '-C', path.dirname(stage), path.basename(stage)], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  }
}

// The section of the changelog headed with this version. A Windows checkout
// has CRLF line endings, so they're evened out first.
function releaseNotes(changelog, version) {
  const text = changelog.replace(/\r\n/g, '\n');
  const escaped = version.replace(/\./g, '\\.');
  const match = text.match(new RegExp(`^## \\[?${escaped}\\]?.*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'));
  if (!match || !match[1].trim()) throw new Error(`CHANGELOG.md has no notes under "## ${version}".`);
  return `${match[1].trim()}\n`;
}

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] || '' : null;
};

// A checksum file beside each release file.
function writeChecksum(file) {
  const hash = sha256(fs.readFileSync(file));
  fs.writeFileSync(`${file}.sha256`, `${hash}  ${path.basename(file)}\n`);
  console.log(`Built ${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)\nSHA-256 ${hash}`);
}

async function main() {
  if (process.argv.includes('--checksums')) {
    const files = fs.readdirSync(DIST).filter((name) => /^tabherd-v.*\.(zip|tar\.gz|exe)$/.test(name));
    for (const name of files) writeChecksum(path.join(DIST, name));
    return;
  }
  const targetName = option('--target') || hostTarget();
  const target = TARGETS[targetName];
  if (!target) throw new Error(`No release target ${targetName}. Targets: ${Object.keys(TARGETS).join(', ')}.`);
  if (target.os === 'win32' && process.platform !== 'win32') throw new Error('The Windows release is built on Windows, where Tauri builds its app and installer.');
  if (target.os !== 'win32' && process.platform === 'win32') throw new Error('The macOS and Linux releases are built on macOS or Linux, which keep their files executable.');
  const notes = releaseNotes(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
  // The folder inside has no version in its name, so each release unpacks to
  // the same folder, and paths to it, such as shortcuts and winget's, last.
  const stage = path.join(DIST, `tabherd-${targetName}`);
  const file = path.join(DIST, `tabherd-v${version}-${targetName}.${target.archive}`);
  const setup = path.join(DIST, `tabherd-v${version}-${targetName}-setup.exe`);
  const only = ['--stage', '--pack'].find((flag) => process.argv.includes(flag));

  if (only !== '--pack') {
    // Only this target's files go, so several targets can be built in turn.
    for (const old of [stage, file, `${file}.sha256`, setup, `${setup}.sha256`]) fs.rmSync(old, { recursive: true, force: true });
    let node = option('--node') ? path.resolve(option('--node')) : null;
    if (!node) {
      const native = targetName === hostTarget() && !process.argv.includes('--download-node');
      if (!native && target.os === 'win32') throw new Error('Give --node <path to node.exe> for another Windows target.');
      node = native ? process.execPath : await downloadNode(target);
    }
    if (targetName === hostTarget()) checkNode(node);
    target.build(stage, node);
    if (only) return console.log(`Built ${path.relative(ROOT, stage)}`);
  }
  if (!fs.existsSync(stage)) throw new Error(`${path.relative(ROOT, stage)} isn't built. Run with --stage first.`);

  archive(target, stage, file);
  writeChecksum(file);
  if (target.installer) writeChecksum(target.installer(stage));
  fs.writeFileSync(path.join(DIST, 'RELEASE_NOTES.md'), notes);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { releaseNotes, TARGETS };
