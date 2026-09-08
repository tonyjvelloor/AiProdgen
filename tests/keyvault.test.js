const { test, describe } = require('node:test');
const assert = require('node:assert');

// Each case needs a fresh module: keyVault caches the resolved secret.
function loadKeyVault(secret) {
    delete require.cache[require.resolve('../lib/keyVault')];
    if (secret === undefined) delete process.env.KEY_ENCRYPTION_SECRET;
    else process.env.KEY_ENCRYPTION_SECRET = secret;
    return require('../lib/keyVault');
}

const HEX32 = 'a'.repeat(64);          // 64 hex chars == 32 bytes
const RAW32 = '12345678901234567890123456789012';

describe('keyVault', () => {
    test('round-trips a value with a 64-char hex secret', () => {
        const kv = loadKeyVault(HEX32);
        const secret = 'sk-live-abc123';
        assert.strictEqual(kv.decryptKey(kv.encryptKey(secret)), secret);
    });

    test('accepts a literal 32-byte secret', () => {
        const kv = loadKeyVault(RAW32);
        assert.strictEqual(kv.decryptKey(kv.encryptKey('x')), 'x');
    });

    // The original bug: a 64-char hex secret was read as utf-8, producing a
    // 64-byte key, so aes-256-gcm threw on every call.
    test('does not treat a hex secret as utf-8', () => {
        const kv = loadKeyVault(HEX32);
        assert.doesNotThrow(() => kv.encryptKey('x'));
    });

    test('refuses to encrypt with no secret configured', () => {
        const kv = loadKeyVault(undefined);
        assert.throws(() => kv.encryptKey('x'), /KEY_ENCRYPTION_SECRET is not set/);
    });

    test('rejects a secret that is neither 64 hex chars nor 32 bytes', () => {
        const kv = loadKeyVault('too-short');
        assert.throws(() => kv.encryptKey('x'), /must be 64 hex characters/);
    });

    test('ciphertext differs across calls (random IV)', () => {
        const kv = loadKeyVault(HEX32);
        assert.notStrictEqual(kv.encryptKey('same'), kv.encryptKey('same'));
    });

    test('a tampered ciphertext fails the auth tag', () => {
        const kv = loadKeyVault(HEX32);
        const buf = Buffer.from(kv.encryptKey('secret'), 'base64');
        buf[buf.length - 1] ^= 0xff;
        assert.throws(() => kv.decryptKey(buf.toString('base64')));
    });
});
