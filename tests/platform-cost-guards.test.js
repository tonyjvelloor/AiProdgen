// tests/platform-cost-guards.test.js
//
// Routes that spend platform money on Replicate must be paid for (credits) or
// limited to the plans that include them. Two did neither: /api/upscale-esrgan
// upscaled for free for any Pro/Agency account, and the image path of
// /api/ugc/render-scene rendered for any account at all, free included.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const appHarness = require('./helpers/app');

require('dotenv').config();

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const HAS_CONFIG = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.JWT_SECRET);

after(async () => { await appHarness.stop(); });

function routeBody(route) {
    const start = server.indexOf(`app.post('${route}'`);
    assert.notStrictEqual(start, -1, `route ${route} not found`);
    const next = server.indexOf('\napp.', start + 10);
    return server.slice(start, next === -1 ? start + 12000 : next);
}

describe('platform-funded routes are paid for or plan-limited', () => {
    test('the uncharged upscale route is gone', () => {
        assert.ok(!server.includes("app.post('/api/upscale-esrgan',"),
            '/api/upscale-esrgan called Replicate without charging a credit');
    });

    test('UGC scene rendering checks the plan allowance before calling Replicate', () => {
        const body = routeBody('/api/ugc/render-scene');
        const gate = body.indexOf('.ugc > 0');
        const firstReplicateCall = body.indexOf('replicate.generate');
        assert.notStrictEqual(gate, -1, 'render-scene must check planConfig.ugc');
        assert.ok(gate < firstReplicateCall, 'the plan check must run before any Replicate call');
        assert.ok(body.includes('overPlatformSpendCeiling'), 'render-scene must apply the platform spend ceiling');
    });

    for (const route of ['/api/video/generate', '/api/image/generate-flux']) {
        test(`${route} refunds only what it actually charged`, () => {
            const body = routeBody(route);
            assert.ok(/if \(!await db\.useCredits\(/.test(body), 'a failed debit must stop the request');
            assert.ok(/credits: charged/.test(body), 'refunding a fixed amount mints credits for errors before the debit');
        });
    }
});

describe('platform cost guards over HTTP', { skip: HAS_CONFIG ? false : 'requires env config' }, () => {
    const jwt = require('jsonwebtoken');
    const db = require('../database');
    let freeUser;

    after(async () => { if (freeUser) await db.deleteUser(freeUser.id).catch(() => {}); });

    const session = (u) => ({
        authorization: `Bearer ${jwt.sign({ userId: u.id, email: u.email, verified: true }, process.env.JWT_SECRET)}`,
        'content-type': 'application/json'
    });

    test('a free account is refused UGC rendering', async () => {
        freeUser = await db.createUser(`costguard-${Date.now()}@example.com`, 'unused-hash', null, null, 0, 'USD');
        const res = await appHarness.request('POST', '/api/ugc/render-scene', session(freeUser),
            JSON.stringify({ prompt: 'a person holding a bottle' }));
        assert.strictEqual(res.statusCode, 403, res.body);
    });

    test('the removed upscale route no longer answers', async () => {
        const user = freeUser || { id: '00000000-0000-0000-0000-000000000000', email: 'nobody@example.com' };
        const res = await appHarness.request('POST', '/api/upscale-esrgan', session(user),
            JSON.stringify({ image: 'x' }));
        assert.strictEqual(res.statusCode, 404, res.body);
    });
});
