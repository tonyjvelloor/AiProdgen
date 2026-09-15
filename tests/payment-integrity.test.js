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
        // landing.html and index.html both advertise $47 / INR 3999 for this
        // offer (they used to disagree at $47 vs $49 -- fixed to match).
        for (const price of ['47', '3999']) {
            assert.ok(block.includes(price), `advertised price ${price} would be rejected at checkout`);
        }
    });

    test('the retired $49 price is no longer accepted', () => {
        // index.html used to advertise $49 for the same offer landing.html
        // sells at $47. Once both pages agreed on $47, $49 should stop being a
        // valid amount rather than staying accepted indefinitely.
        const block = server.slice(server.indexOf('const LIFETIME_OFFER_PRICES'),
                                   server.indexOf('const LIFETIME_OFFER_PRICES') + 220);
        assert.ok(!/\b49\b/.test(block), '$49 is still in the allowlist after the pages were made consistent');
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

// app.html's in-app upgrade modal sends planId as 'creator' / 'pro' / 'agency'
// -- the same display aliases getPlanConfig() already resolves for gating --
// but /api/plan/subscribe looked those keys up directly in PLAN_PRICES, whose
// keys are 'hobbyist_ltd' / 'pro_founder_ltd' / 'agency_ltd'. Every upgrade
// attempt 400'd before an order was ever created, and /api/plan/verify had the
// identical unresolved lookup, so fixing only one would have moved the failure
// rather than removed it.
describe('plan subscribe/verify resolve the same aliases as plan gating', () => {
    test('both routes resolve planId through PLAN_ALIASES', () => {
        for (const routeStart of ["app.post('/api/plan/subscribe'", "app.post('/api/plan/verify'"]) {
            const start = server.indexOf(routeStart);
            assert.notStrictEqual(start, -1, `${routeStart} not found`);
            const body = server.slice(start, start + 1500);
            assert.ok(/PLAN_ALIASES\[raw ?[Pp]lan[Ii]d\]/.test(body) || body.includes('PLAN_ALIASES[rawPlanId]'),
                `${routeStart} does not resolve the display alias before looking up PLAN_PRICES`);
        }
    });

    test('subscribe no longer builds an unmatchable billingCycle_currency key', () => {
        const start = server.indexOf("app.post('/api/plan/subscribe'");
        const end = server.indexOf("app.post('/api/plan/verify'");
        const route = server.slice(start, end);
        // PLAN_PRICES only ever defined onetime_usd; the old key construction
        // (`${billingCycle}_${currency.toLowerCase()}`) could never match it.
        assert.ok(!/`\$\{billingCycle\}_\$\{useCurrency/.test(route),
            'the old unmatchable price-key construction is still present');
        assert.ok(route.includes('onetime_usd'), 'subscribe must charge the real configured price');
    });
});

describe('an aliased plan reaches checkout', { skip: HAS_CONFIG ? false : 'requires env config' }, () => {
    const jwt = require('jsonwebtoken');
    const session = () => ({
        authorization: `Bearer ${jwt.sign({ userId: '11111111-1111-1111-1111-111111111111', email: 'x@example.com', verified: true }, process.env.JWT_SECRET)}`,
        'content-type': 'application/json'
    });

    for (const alias of ['creator', 'pro', 'agency']) {
        test(`planId "${alias}" is not rejected as invalid`, async () => {
            const res = await appHarness.request('POST', '/api/plan/subscribe', session(),
                JSON.stringify({ planId: alias, billingCycle: 'monthly', currency: 'USD' }));
            // Razorpay may still fail against a test/misconfigured account (500),
            // but the alias itself must never be the reason -- that was the bug.
            const body = JSON.parse(res.body || '{}');
            assert.notStrictEqual(body.error, 'Invalid plan. Choose creator, pro, or agency.',
                `"${alias}" was rejected as an unknown plan — the alias did not resolve`);
        });
    }
});
