const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const appHarness = require('./helpers/app');

require('dotenv').config();

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const HAS_CONFIG = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.JWT_SECRET);

after(async () => { await appHarness.stop(); });

// /api/payment/create-order is unauthenticated by design -- it is the
// sign-up-and-pay flow -- and took `amount` from the request body with no
// check. /api/payment/verify then validated only the Razorpay signature, which
// is valid for whatever amount was ordered. POST {email, amount: 1} bought a
// full lifetime account for a dollar.
describe('checkout price cannot be set by the client', () => {
    test('the route validates against an allowlist', () => {
        const route = server.slice(server.indexOf("app.post('/api/payment/create-order'"),
                                   server.indexOf("app.post('/api/payment/verify'"));
        assert.ok(route.includes('LIFETIME_OFFER_PRICES'), 'order price must be checked server-side');
        assert.ok(/Invalid amount/.test(route), 'a disallowed amount must be rejected');
    });

    test('the allowlist covers the prices the pages advertise', () => {
        const block = server.slice(server.indexOf('const LIFETIME_OFFER_PRICES'),
                                   server.indexOf('const LIFETIME_OFFER_PRICES') + 220);
        // landing.html offers $47, index.html offers $49, both offer INR 3999.
        for (const price of ['47', '49', '3999']) {
            assert.ok(block.includes(price), `advertised price ${price} would be rejected at checkout`);
        }
    });

    test('no hardcoded 47 fallback remains', () => {
        const route = server.slice(server.indexOf("app.post('/api/payment/create-order'"),
                                   server.indexOf("app.post('/api/payment/verify'"));
        assert.ok(!/amount\s*\|\|\s*47/.test(route),
            'the old default charged $47 regardless of currency');
    });
});

describe('a tampered price is refused', { skip: HAS_CONFIG ? false : 'requires env config' }, () => {
    for (const amount of [1, 0, -50, 0.01]) {
        test(`rejects amount ${amount}`, async () => {
            const res = await appHarness.request('POST', '/api/payment/create-order',
                { 'content-type': 'application/json' },
                JSON.stringify({ email: `tamper${Date.now()}@example.com`, amount, currency: 'USD' }));
            assert.notStrictEqual(res.statusCode, 200,
                `an order for $${amount} must not be created`);
        });
    }

    test('rejects an unsupported currency', async () => {
        const res = await appHarness.request('POST', '/api/payment/create-order',
            { 'content-type': 'application/json' },
            JSON.stringify({ email: `cur${Date.now()}@example.com`, amount: 47, currency: 'XYZ' }));
        assert.strictEqual(res.statusCode, 400);
    });
});
