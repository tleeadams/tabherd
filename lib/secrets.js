'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('./store');

// Secrets in Tabherd's JSON files are encrypted with AES-256-GCM, as
// "enc:v1:" and the base64 of the IV, tag and ciphertext. The key is 32
// random bytes that the operating system keeps for the signed-in user, made
// the first time a secret is saved:
// - Windows: protected with DPAPI for the current user, in secret.key.
// - macOS: an item in the login Keychain.
// - Linux: the Secret Service (GNOME Keyring, KWallet), through secret-tool;
//   without one, secret.key, readable only by its owner.
// A file copied to another computer or user can't be read there, and what
// can't be read counts as unset.

const PREFIX = 'enc:v1:';
const KEY_FILE = path.join(store.DATA_DIR, 'secret.key');
const LABEL = 'Tabherd settings key';
// Each data folder has a key of its own, so a test's, or a second copy's,
// can't touch yours.
const ACCOUNT = store.DATA_DIR;

// A key that's there but can't be unlocked by this user on this computer,
// as against a key store that didn't answer.
class Elsewhere extends Error {}

const run = (cmd, args, input) =>
  execFileSync(cmd, args, { input, encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });

// DPAPI through Windows PowerShell, which every Windows has. The key goes in
// and out on standard input and output, never on a command line.
function dpapi(op, base64) {
  const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security
$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes('${LABEL}')
$out = [Security.Cryptography.ProtectedData]::${op}($in, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($out))`;
  try {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], base64).trim();
  } catch (err) {
    if (/CryptographicException/.test(String(err.stderr))) throw new Elsewhere('The saved secrets were encrypted by another Windows user or computer.');
    throw new Error("Windows' data protection didn't answer.");
  }
}

const fromHex = (text) => {
  const key = Buffer.from(String(text).trim(), 'hex');
  if (key.length !== 32) throw new Elsewhere('The saved key is damaged.');
  return key;
};

function readKeyFile() {
  return fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8') : null;
}

function writeKeyFile(text) {
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  const temp = `${KEY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, KEY_FILE);
}

const PROVIDERS = {
  win32: {
    protection: 'dpapi',
    read() {
      const blob = readKeyFile();
      return blob ? Buffer.from(dpapi('Unprotect', blob), 'base64') : null;
    },
    create(key) {
      writeKeyFile(dpapi('Protect', key.toString('base64')));
    },
  },
  darwin: {
    protection: 'keychain',
    read() {
      try {
        return fromHex(run('security', ['find-generic-password', '-a', ACCOUNT, '-s', LABEL, '-w']));
      } catch (err) {
        // 44: no such item yet.
        if (err.status === 44) return null;
        if (err instanceof Elsewhere) throw err;
        throw new Error("The Keychain didn't give the key.");
      }
    },
    create(key) {
      if (/["\\\n]/.test(ACCOUNT)) throw new Error("The data folder's path can't be used as a Keychain account.");
      // Interactive mode takes the command on standard input, so the key never
      // shows in a process list.
      run('security', ['-i'], `add-generic-password -U -a "${ACCOUNT}" -s "${LABEL}" -w ${key.toString('hex')}\n`);
      if (!this.read()?.equals(key)) throw new Error("The Keychain didn't keep the key.");
    },
  },
  linux: {
    protection: 'secret-service',
    read() {
      // A key file means the Secret Service wasn't there when the key was made.
      const file = readKeyFile();
      if (file) {
        this.protection = 'file';
        return fromHex(file);
      }
      try {
        const found = run('secret-tool', ['lookup', 'service', 'tabherd', 'account', ACCOUNT]).trim();
        return found ? fromHex(found) : null;
      } catch (err) {
        if (err instanceof Elsewhere) throw err;
        return null;
      }
    },
    create(key) {
      try {
        run('secret-tool', ['store', `--label=${LABEL}`, 'service', 'tabherd', 'account', ACCOUNT], key.toString('hex'));
        if (fromHex(run('secret-tool', ['lookup', 'service', 'tabherd', 'account', ACCOUNT])).equals(key)) return;
      } catch {}
      writeKeyFile(key.toString('hex'));
      this.protection = 'file';
    },
  },
};

let provider = PROVIDERS[process.platform] || PROVIDERS.linux;
let key = null;
// null until the key store has been asked; then 'ready', 'none' (no key made
// yet), 'elsewhere' (one that can't be unlocked here) or 'failed'.
let state = null;
let problem = null;

function load() {
  if (state) return;
  try {
    key = provider.read();
    state = key ? 'ready' : 'none';
  } catch (err) {
    state = err instanceof Elsewhere ? 'elsewhere' : 'failed';
    problem = err.message;
  }
}

const isEncrypted = (value) => typeof value === 'string' && value.startsWith(PREFIX);

// Any JSON value, encrypted. The first secret saved makes the key; one that
// can't be unlocked here is replaced, as what it locked is lost anyway. A key
// store that didn't answer throws, so nothing is saved unencrypted.
function encrypt(value) {
  load();
  if (state === 'failed') throw new Error(problem);
  if (!key) {
    const next = crypto.randomBytes(32);
    provider.create(next);
    key = next;
    state = 'ready';
    problem = null;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

// The value, or undefined if it can't be decrypted here.
function decrypt(text) {
  if (!isEncrypted(text)) return undefined;
  load();
  if (!key) return undefined;
  try {
    const raw = Buffer.from(text.slice(PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  } catch {
    return undefined;
  }
}

// How secrets are kept here, for Settings.
function status() {
  load();
  return { protection: provider.protection, state, problem };
}

// For tests: this key, kept in memory only.
function useKey(k) {
  provider = { protection: 'test', read: () => k, create() {} };
  key = k;
  state = k ? 'ready' : null;
  problem = null;
}

module.exports = { encrypt, decrypt, isEncrypted, status, useKey };
