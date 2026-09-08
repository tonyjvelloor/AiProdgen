const { test, describe, after } = require('node:test');
const assert = require('node:assert');

require('dotenv').config();

const HAS_CONFIG = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.JWT_SECRET);
const skip = HAS_CONFIG ? false : 'requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and JWT_SECRET';

const appHarness = require('./helpers/app');

const call = (method, path, headers = {}) => appHarness.request(method, path, headers);

after(async () => { await appHarness.stop(); });

const ADMIN_ROUTES = ['/api/admin/stats', '/api/admin/users', '/api/admin/metrics'];

describe('admin authorization', { skip }, () => {
    test('rejects requests with no credentials', async () => {
        for (const route of ADMIN_ROUTES) {
            const res = await call('GET', route);
            assert.strictEqual(res.statusCode, 401, `${route} must reject anonymous access`);
        }
    });

    // Regression: this token was hardcoded in server.js and handed out by an
    // admin/admin123 login, both committed to the repository.
    test('rejects the retired hardcoded admin token', async () => {
        for (const route of ADMIN_ROUTES) {
            const res = await call('GET', route, { 'x-admin-token': 'your-admin-secret-token-123' });
            assert.strictEqual(res.statusCode, 401, `${route} must not honour the old token`);
        }
    });

    test('rejects a valid session that is not an admin', async () => {
        const jwt = require('jsonwebtoken');
        const token = jwt.sign(
            { userId: '00000000-0000-0000-0000-000000000000', email: 'notadmin@example.com' },
            process.env.JWT_SECRET
        );
        for (const route of ADMIN_ROUTES) {
            const res = await call('GET', route, { authorization: `Bearer ${token}` });
            assert.strictEqual(res.statusCode, 403, `${route} must require the is_admin flag`);
        }
    });

    test('rejects a token signed with the retired default secret', async () => {
        const jwt = require('jsonwebtoken');
        const forged = jwt.sign(
            { userId: '00000000-0000-0000-0000-000000000000', email: 'attacker@example.com' },
            'your-secret-key-change-in-production'
        );
        const res = await call('GET', '/api/admin/stats', { authorization: `Bearer ${forged}` });
        assert.strictEqual(res.statusCode, 401);
    });

    test('the retired /api/admin/login route is gone', async () => {
        const res = await call('POST', '/api/admin/login');
        assert.notStrictEqual(res.statusCode, 200, 'admin/admin123 login must not exist');
    });
});

describe('health endpoint', { skip }, () => {
    test('reports configuration without leaking values', async () => {
        const res = await call('GET', '/api/health');
        const body = JSON.parse(res.body);
        assert.ok(Array.isArray(body.missingRequiredEnv));
        assert.strictEqual(typeof body.supabaseConfigured, 'boolean');
        assert.strictEqual(typeof body.rateLimitingEnabled, 'boolean');
        // presence only -- never the values themselves
        const serialised = JSON.stringify(body);
        assert.ok(!serialised.includes(process.env.SUPABASE_SERVICE_ROLE_KEY));
        assert.ok(!serialised.includes(process.env.JWT_SECRET));
    });
});
