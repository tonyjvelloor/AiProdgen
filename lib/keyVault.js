// lib/keyVault.js
const crypto = require('crypto');
const ALGO = 'aes-256-gcm';
const SECRET = Buffer.from(process.env.KEY_ENCRYPTION_SECRET || '12345678901234567890123456789012', 'utf-8'); // Using utf-8 fallback for local dev if env is missing

function encryptKey(rawKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, SECRET, iv);
  const encrypted = Buffer.concat([cipher.update(rawKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptKey(stored) {
  const data = Buffer.from(stored, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, SECRET, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encryptKey, decryptKey };
