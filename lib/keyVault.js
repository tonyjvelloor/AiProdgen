// lib/keyVault.js
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

// aes-256-gcm needs exactly 32 bytes of key material. KEY_ENCRYPTION_SECRET is
// documented as 32 bytes of hex (64 characters), so it must be decoded as hex —
// reading it as utf-8 yields 64 bytes and createCipheriv throws
// "Invalid key length" on every call.
//
// There is deliberately no default. A fallback key would silently encrypt every
// customer's provider credentials under a value committed to this repo, and the
// failure would look like success.
let cachedSecret = null;

function getSecret() {
    if (cachedSecret) return cachedSecret;

    const raw = process.env.KEY_ENCRYPTION_SECRET;
    if (!raw) {
        throw new Error(
            'KEY_ENCRYPTION_SECRET is not set. BYOK credential storage is disabled. ' +
            'Generate one with: openssl rand -hex 32'
        );
    }

    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
        cachedSecret = Buffer.from(raw, 'hex');
        return cachedSecret;
    }

    // Tolerate a raw 32-byte passphrase, but nothing that would produce a
    // wrong-length key.
    const utf8 = Buffer.from(raw, 'utf-8');
    if (utf8.length === 32) {
        cachedSecret = utf8;
        return cachedSecret;
    }

    throw new Error(
        `KEY_ENCRYPTION_SECRET must be 64 hex characters (32 bytes), or a 32-byte string; ` +
        `got ${raw.length} characters. Generate one with: openssl rand -hex 32`
    );
}

function encryptKey(rawKey) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, getSecret(), iv);
    const encrypted = Buffer.concat([cipher.update(rawKey, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptKey(stored) {
    const data = Buffer.from(stored, 'base64');
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, getSecret(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encryptKey, decryptKey };
