const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const appHarness = require('./helpers/app');

require('dotenv').config();

after(async () => { await appHarness.stop(); });

// The Vercel entry was wrapped in serverless-http, which builds an AWS Lambda
// (event, context) handler. Vercel invokes functions with (req, res), so the
// wrapper never wrote a response and every /api route hung for the full 300s
// until FUNCTION_INVOCATION_TIMEOUT -- while static files served fine, which is
// what made it look like a partial outage rather than a broken entry point.
describe('vercel entry point', () => {
    test('exports a (req, res) handler, not a Lambda handler', () => {
        const handler = require('../api/index.js');
        assert.strictEqual(typeof handler, 'function');
        assert.ok(handler.length >= 2, 'handler must accept (req, res)');
    });

    test('every /api route answers promptly', async () => {
        // Includes a route Express does not define: the 404 must come back fast
        // too, since a hang shows up on unknown paths first.
        for (const path of ['/api/health', '/api/credits/packages', '/api/definitely-not-a-route']) {
            const started = Date.now();
            const res = await appHarness.request('GET', path);
            const elapsed = Date.now() - started;

            assert.ok(res.statusCode > 0, `${path} returned no status`);
            assert.ok(elapsed < 5000, `${path} took ${elapsed}ms — the entry point is hanging`);
        }
    });

    test('an unknown /api path 404s rather than hanging', async () => {
        const res = await appHarness.request('GET', '/api/definitely-not-a-route');
        assert.strictEqual(res.statusCode, 404);
    });

    test('static assets still serve', async () => {
        const res = await appHarness.request('GET', '/landing.html');
        assert.strictEqual(res.statusCode, 200);
    });
});
