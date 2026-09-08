const { test, describe, after } = require('node:test');
const assert = require('node:assert');

require('dotenv').config();

const HAS_CONFIG = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.JWT_SECRET);
const skip = HAS_CONFIG ? false : 'requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and JWT_SECRET';

const appHarness = require('./helpers/app');
const jwt = require('jsonwebtoken');

const call = (method, path, headers = {}) => appHarness.request(method, path, headers);
const sessionFor = (userId) => ({
    authorization: `Bearer ${jwt.sign({ userId, email: `${userId}@example.com` }, process.env.JWT_SECRET || 'unused')}`
});

after(async () => { await appHarness.stop(); });

// A provider job id (Replicate prediction / Veo operation) used to be enough to
// read anyone's result, because the status routes proxied straight through.
const STATUS_ROUTES = [
    '/api/video/status/pred_someoneelses_id',
    '/api/video/veo-status/operations%2Fsomeone-elses-op',
    '/api/ugc/render-scene/status/pred_someoneelses_id'
];

describe('async job ownership', { skip }, () => {
    test('status routes still require authentication', async () => {
        for (const route of STATUS_ROUTES) {
            const res = await call('GET', route);
            assert.strictEqual(res.statusCode, 401, `${route} must reject anonymous access`);
        }
    });

    test('a job the caller did not start is never proxied to the provider', async () => {
        const headers = sessionFor('11111111-1111-1111-1111-111111111111');
        for (const route of STATUS_ROUTES) {
            const res = await call('GET', route, headers);
            assert.ok(
                res.statusCode === 403 || res.statusCode === 404,
                `${route} returned ${res.statusCode}; expected 403 or 404 for an unowned job`
            );
        }
    });

    test('two different users cannot reach the same job id', async () => {
        const a = sessionFor('11111111-1111-1111-1111-111111111111');
        const b = sessionFor('22222222-2222-2222-2222-222222222222');
        const route = STATUS_ROUTES[0];
        const [resA, resB] = await Promise.all([call('GET', route, a), call('GET', route, b)]);
        for (const res of [resA, resB]) {
            assert.ok(res.statusCode === 403 || res.statusCode === 404);
        }
    });
});
