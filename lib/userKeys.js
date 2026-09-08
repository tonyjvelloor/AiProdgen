// lib/userKeys.js
//
// Reads a caller's own provider key from the encrypted vault.
//
// /api/keys/add has always stored BYOK credentials AES-256-GCM encrypted in
// user_api_keys, but nothing read them back on the Express side: routes only
// looked at req.body.apiKey / x-api-key. The practical effect was that the
// browser had to hold the raw key in localStorage and send it on every request,
// which is XSS-readable and means the vault existed without being used.
//
// With this, a user saves a key once and the server resolves it per request.
const { supabaseAdmin } = require('./supabase');
const { decryptKey } = require('./keyVault');

// Small per-invocation cache. Serverless instances are short-lived, so this
// avoids a round trip per generation without holding decrypted keys long.
const cache = new Map();
const TTL_MS = 60 * 1000;

async function getUserProviderKey(userId, provider = 'gemini') {
    if (!userId) return null;

    const cacheKey = `${userId}:${provider}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.key;

    const { data, error } = await supabaseAdmin
        .from('user_api_keys')
        .select('encrypted_key')
        .eq('user_id', userId)
        .eq('provider', provider)
        .maybeSingle();

    if (error || !data) return null;

    try {
        const key = decryptKey(data.encrypted_key);
        cache.set(cacheKey, { key, expires: Date.now() + TTL_MS });
        return key;
    } catch (e) {
        // A key encrypted under a different KEY_ENCRYPTION_SECRET cannot be
        // recovered. Say so rather than silently behaving as if none was saved.
        console.error(`[keys] could not decrypt ${provider} key for ${userId}: ${e.message}`);
        return null;
    }
}

async function hasUserProviderKey(userId, provider = 'gemini') {
    return !!(await getUserProviderKey(userId, provider));
}

module.exports = { getUserProviderKey, hasUserProviderKey };
