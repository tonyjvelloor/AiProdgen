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
    test('subscribe resolves planId through PLAN_ALIASES', () => {
        const start = server.indexOf("app.post('/api/plan/subscribe'");
        assert.notStrictEqual(start, -1);
        assert.ok(server.slice(start, start + 1500).includes('PLAN_ALIASES[rawPlanId]'),
            'subscribe does not resolve the display alias before looking up PLAN_PRICES');
    });

    test('verify takes the plan from the stored order, never the request body', () => {
        const start = server.indexOf("app.post('/api/plan/verify'");
        const route = server.slice(start, server.indexOf('\napp.', start + 10));
        assert.ok(route.includes('claimPendingOrder') && route.includes('planForOrder'),
            'verify must derive the plan from the order the user created');
        assert.ok(!/planId[^\n]*=[^\n]*req\.body/.test(route) && !/\{[^}]*planId[^}]*\}\s*=\s*req\.body/.test(route),
            'verify must not read planId from the request body');
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
    // subscribe now records a pending order for each order Razorpay creates.
    after(async () => {
        const { supabaseAdmin } = require('../lib/supabase');
        await supabaseAdmin.from('pending_orders').delete().eq('email', 'x@example.com');
    });
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

// The Razorpay signature proves an order was paid -- not what it was for. The
// verify routes used to take planId/packageId from the request body, so a $5
// credit-pack payment could be submitted as an Agency plan purchase, and the
// same payment could be re-submitted to grant credits again and again. What an
// order bought is now stored when it is created and read back at verify.
describe('every product has a distinct price', () => {
    test('no plan, credit pack, or lifetime offer shares an (amount, currency)', () => {
        const vm = require('node:vm');
        const grab = (name) => {
            const start = server.indexOf(`const ${name} = {`);
            assert.notStrictEqual(start, -1, `${name} not found`);
            const end = server.indexOf('\n};', start) + 3;
            return vm.runInNewContext(`(${server.slice(server.indexOf('{', start), end - 1)})`);
        };
        const seen = new Map();
        const add = (key, label) => {
            assert.ok(!seen.has(key), `${label} and ${seen.get(key)} share ${key}; a stored order would no longer identify one product`);
            seen.set(key, label);
        };
        for (const [id, p] of Object.entries(grab('PLAN_PRICES'))) add(`USD ${p.onetime_usd}`, `plan ${id}`);
        for (const [id, p] of Object.entries(grab('CREDIT_PACKAGES'))) {
            add(`USD ${p.amount_usd}`, `credits ${id}`);
            add(`INR ${p.amount_inr}`, `credits ${id}`);
        }
        for (const [cur, prices] of Object.entries(grab('LIFETIME_OFFER_PRICES'))) {
            for (const price of prices) add(`${cur} ${Math.round(price * 100)}`, `lifetime ${cur}`);
        }
    });
});

describe('in-app payments are bound to what was ordered and single-use',
    { skip: HAS_CONFIG && process.env.RAZORPAY_KEY_SECRET ? false : 'requires env config' }, () => {
    const crypto = require('node:crypto');
    const jwt = require('jsonwebtoken');
    const db = require('../database');
    const { supabaseAdmin } = require('../lib/supabase');

    const sign = (o, p) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${o}|${p}`).digest('hex');
    const sessionFor = (u) => ({
        authorization: `Bearer ${jwt.sign({ userId: u.id, email: u.email }, process.env.JWT_SECRET)}`,
        'content-type': 'application/json'
    });
    const ids = () => { const n = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; return [`order_it_${n}`, `pay_it_${n}`]; };
    const verify = (route, user, orderId, paymentId, extra = {}) => appHarness.request('POST', route, sessionFor(user),
        JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId), ...extra }));

    const users = [];
    const newUser = async () => {
        const u = await db.createUser(`integrity-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, 'unused-hash', null, null, 0, 'USD');
        users.push(u);
        return u;
    };
    after(async () => {
        if (users.length) await supabaseAdmin.from('payments').delete().in('user_id', users.map(u => u.id));
        for (const u of users) {
            await supabaseAdmin.from('pending_orders').delete().eq('email', u.email);
            await db.deleteUser(u.id).catch(() => {});
        }
    });

    test('a credit-pack payment cannot activate a plan', async () => {
        const user = await newUser();
        const [orderId, paymentId] = ids();
        await db.createPendingOrder(orderId, user.email, 500, 'USD'); // $5 starter pack
        const res = await verify('/api/plan/verify', user, orderId, paymentId, { planId: 'agency' });
        assert.strictEqual(res.statusCode, 400, res.body);
        assert.strictEqual((await db.getUserPlan(user.id)).plan, 'free_explorer');
    });

    test('the plan comes from the order, not the request body', async () => {
        const user = await newUser();
        const [orderId, paymentId] = ids();
        await db.createPendingOrder(orderId, user.email, 4900, 'USD'); // Creator
        const res = await verify('/api/plan/verify', user, orderId, paymentId, { planId: 'agency' });
        assert.strictEqual(res.statusCode, 200, res.body);
        assert.strictEqual((await db.getUserPlan(user.id)).plan, 'hobbyist_ltd', 'a $49 order must never activate Agency');
    });

    test('a plan payment can only be redeemed once', async () => {
        const user = await newUser();
        const [orderId, paymentId] = ids();
        await db.createPendingOrder(orderId, user.email, 9700, 'USD'); // Pro
        assert.strictEqual((await verify('/api/plan/verify', user, orderId, paymentId)).statusCode, 200);
        const creditsAfterFirst = await db.getUserCredits(user.id);
        const replay = await verify('/api/plan/verify', user, orderId, paymentId);
        assert.strictEqual(replay.statusCode, 400, 'a replayed payment must be refused');
        assert.strictEqual(await db.getUserCredits(user.id), creditsAfterFirst, 'a replay must not grant plan credits again');
    });

    test("one user cannot redeem another user's order", async () => {
        const owner = await newUser(), other = await newUser();
        const [orderId, paymentId] = ids();
        await db.createPendingOrder(orderId, owner.email, 19700, 'USD');
        const res = await verify('/api/plan/verify', other, orderId, paymentId);
        assert.strictEqual(res.statusCode, 400, res.body);
        assert.strictEqual((await db.getUserPlan(other.id)).plan, 'free_explorer');
        assert.ok(await db.getPendingOrder(orderId), "the owner's order must still be redeemable by the owner");
    });

    test('credits come from the order, and a credit payment is single-use', async () => {
        const user = await newUser();
        const [orderId, paymentId] = ids();
        await db.createPendingOrder(orderId, user.email, 500, 'USD'); // starter: 50 credits
        const res = await verify('/api/credits/verify', user, orderId, paymentId, { packageId: 'agency', currency: 'USD' });
        assert.strictEqual(res.statusCode, 200, res.body);
        assert.strictEqual(await db.getUserCredits(user.id), 50, 'a $5 order must grant 50 credits, not the 1,000 the body asked for');
        const replay = await verify('/api/credits/verify', user, orderId, paymentId, { packageId: 'starter' });
        assert.strictEqual(replay.statusCode, 400, 'a replayed credit payment must be refused');
        assert.strictEqual(await db.getUserCredits(user.id), 50);
    });

    test('the lifetime checkout refuses an order that is not the lifetime offer', async () => {
        const email = `integrity-lt-${Date.now()}@example.com`;
        const [orderId, paymentId] = ids();
        await db.createPendingOrder(orderId, email, 500, 'USD');
        const res = await appHarness.request('POST', '/api/payment/verify', { 'content-type': 'application/json' },
            JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) }));
        assert.strictEqual(res.statusCode, 400, res.body);
        assert.strictEqual(await db.getUserByEmail(email), null, 'no account may be created from a non-lifetime order');
        await db.deletePendingOrder(orderId);
    });
});
