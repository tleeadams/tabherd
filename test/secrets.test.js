'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TABHERD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tabherd-test-'));

// The module afresh, as a new start of the server loads it.
function fresh() {
  for (const m of ['../lib/secrets', '../lib/store']) delete require.cache[require.resolve(m)];
  return require('../lib/secrets');
}

test('values go in encrypted and come out the same', () => {
  const secrets = fresh();
  secrets.useKey(crypto.randomBytes(32));
  for (const value of ['sk-123', [{ id: 1, token: 'x' }], '']) {
    const sealed = secrets.encrypt(value);
    assert.ok(secrets.isEncrypted(sealed));
    assert.deepEqual(secrets.decrypt(sealed), value);
  }
  assert.notEqual(secrets.encrypt('same'), secrets.encrypt('same'), 'a new IV each time');
});

test("another key's value, a damaged one or a plain one reads as nothing", () => {
  const secrets = fresh();
  secrets.useKey(crypto.randomBytes(32));
  const sealed = secrets.encrypt('sk-123');
  secrets.useKey(crypto.randomBytes(32));
  assert.equal(secrets.decrypt(sealed), undefined);
  assert.equal(secrets.decrypt(`${sealed.slice(0, -4)}AAAA`), undefined);
  assert.equal(secrets.decrypt('sk-123'), undefined);
  assert.equal(secrets.isEncrypted('sk-123'), false);
});

// The computer's own key store. On Windows it's a file in the test's data
// folder; elsewhere it's the user's Keychain or keyring, so it's only tried
// on CI's throwaway machines.
const realStore = process.platform === 'win32' || process.env.CI;
test("the operating system's key store keeps the key between starts", { skip: !realStore && 'uses the real Keychain or keyring' }, () => {
  let secrets = fresh();
  assert.equal(secrets.status().state, 'none', 'no key until a secret is saved');
  const sealed = secrets.encrypt('kept between starts');
  assert.equal(secrets.status().state, 'ready');
  secrets = fresh();
  assert.equal(secrets.decrypt(sealed), 'kept between starts');
  if (process.platform === 'win32') {
    const file = fs.readFileSync(path.join(process.env.TABHERD_DATA_DIR, 'secret.key'), 'utf8');
    assert.ok(file.length > 100, 'a DPAPI blob, not the key itself');
  }
});
