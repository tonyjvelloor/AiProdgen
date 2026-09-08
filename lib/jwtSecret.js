// lib/jwtSecret.js
// Single source of truth for the session-signing secret.
//
// This used to be `process.env.JWT_SECRET || 'your-secret-key-change-in-production'`,
// duplicated in three places. A deploy missing the variable would sign sessions
// with a string published in this repository, so anyone could mint a valid token
// for any user id. It must fail closed instead.
//
// Resolved lazily: throwing at import time would kill the whole serverless
// function before Express registers a route, which surfaces as an opaque
// FUNCTION_INVOCATION_FAILED rather than a usable error.
let cached = null;

function getJwtSecret() {
    if (cached) return cached;

    const secret = process.env.SESSION_JWT_SECRET || process.env.JWT_SECRET;
    if (!secret) {
        throw new Error(
            'JWT_SECRET is not set. Refusing to sign or verify sessions with a default. ' +
            'Generate one with: openssl rand -hex 32'
        );
    }

    cached = secret;
    return cached;
}

module.exports = { getJwtSecret };
