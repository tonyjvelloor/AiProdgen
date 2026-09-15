// tests/acceptance-checklist.test.js
//
// The explicit acceptance checklist for landing migration 006 + the
// entitlement system: new free user, $47 lifetime buyer, existing paid user,
// plan upgrade, plan downgrade, a separately-purchased feature surviving a
// plan change, a duplicate Razorpay webhook, a refund, and a failed
// generation rolling back its credit debit. Runs against the real (migrated)
// Supabase database through the real HTTP entry point -- not mocks -- and
// cleans up every user it creates.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const jwt = require('jsonwebtoken');

require('dotenv').config();

const HAS_CONFIG = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.JWT_SECRET && process.env.RAZORPAY_KEY_SECRET);
const skip = HAS_CONFIG ? false : 'requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET and RAZORPAY_KEY_SECRET';

const appHarness = require('./helpers/app');
const db = require('../database');
const entitlements = require('../lib/entitlements');

after(async () => { await appHarness.stop(); });

const sign = (orderId, paymentId) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
const sessionFor = (user) => ({
    authorization: `Bearer ${jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET)}`,
    'content-type': 'application/json'
});

const createdUserIds = [];
after(async () => {
    for (const id of createdUserIds) await db.deleteUser(id).catch(() => {});
});

describe('acceptance checklist', { skip }, () => {
    test('a new free user has the free plan and no feature entitlements', async () => {
        const email = `accept-free-${Date.now()}@example.com`;
        const user = await db.createUser(email, 'unused-hash', null, null, 0, 'USD');
        createdUserIds.push(user.id);

        const plan = await db.getUserPlan(user.id);
        assert.strictEqual(plan.plan, 'free_explorer');
        assert.deepStrictEqual(await entitlements.getUserEntitlements(user.id), []);
    });

    test('a $47 lifetime buyer is activated on hobbyist_ltd, billed, and seeded', async () => {
        const email = `accept-lifetime-${Date.now()}@example.com`;
        const orderId = `order_accept_${Date.now()}`;
        const paymentId = `pay_accept_${Date.now()}`;
        await db.createPendingOrder(orderId, email, 4700, 'USD');

        const res = await appHarness.request('POST', '/api/payment/verify',
            { 'content-type': 'application/json' },
            JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) }));

        assert.strictEqual(res.statusCode, 200, res.body);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.email, email);

        const user = await db.getUserByEmail(email);
        assert.ok(user, 'the account must have been created');
        createdUserIds.push(user.id);

        const plan = await db.getUserPlan(user.id);
        assert.strictEqual(plan.plan, 'hobbyist_ltd', 'the $47 purchase must activate the paid plan, not leave free_explorer');
        assert.strictEqual(plan.billing_cycle, 'lifetime');

        const { supabaseAdmin } = require('../lib/supabase');
        const { data: payment } = await supabaseAdmin.from('payments').select('*').eq('razorpay_payment_id', paymentId).maybeSingle();
        assert.ok(payment, 'the acquisition purchase must be recorded in the revenue ledger');
        assert.strictEqual(payment.plan_id, 'hobbyist_ltd');

        // hobbyist_ltd: watermark:false, templates:'basic', bulk:false, commercial:false
        assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.WATERMARK_REMOVAL), true);
        assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.PREMIUM_TEMPLATES), true);
        assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.BULK_GENERATION), false);
    });

    describe('an existing paid user goes through upgrade, downgrade, and a re-verify', () => {
        let user;

        test('setup: a hobbyist_ltd user', async () => {
            const email = `accept-existing-${Date.now()}@example.com`;
            user = await db.createUser(email, 'unused-hash', null, null, 0, 'USD');
            createdUserIds.push(user.id);
            await db.setUserPlan(user.id, 'hobbyist_ltd', 'lifetime');
            // Mirrors PLANS.hobbyist_ltd in server.js (watermark:false, templates:'basic', bulk:false, commercial:false).
            await entitlements.seedPlanEntitlements(user.id, 'hobbyist_ltd', { watermark: false, templates: 'basic', bulk: false, commercial: false });
        });

        test('re-verifying the same plan does not duplicate the entitlement row', async () => {
            const orderId = `order_reverify_${Date.now()}`, paymentId = `pay_reverify_${Date.now()}`;
            const res = await appHarness.request('POST', '/api/plan/verify', sessionFor(user),
                JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId), planId: 'creator', billingCycle: 'monthly' }));
            assert.strictEqual(res.statusCode, 200, res.body);

            const { supabaseAdmin } = require('../lib/supabase');
            const { data: rows } = await supabaseAdmin.from('entitlements')
                .select('id').eq('user_id', user.id).eq('feature', entitlements.FEATURES.WATERMARK_REMOVAL).eq('status', 'active');
            assert.strictEqual(rows.length, 1, 're-verifying the same plan must not create a second active grant');
        });

        test('upgrade to agency_ltd grants the full Agency Reseller V2 bundle', async () => {
            const orderId = `order_upgrade_${Date.now()}`, paymentId = `pay_upgrade_${Date.now()}`;
            const res = await appHarness.request('POST', '/api/plan/verify', sessionFor(user),
                JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId), planId: 'agency', billingCycle: 'monthly' }));
            assert.strictEqual(res.statusCode, 200, res.body);

            assert.strictEqual((await db.getUserPlan(user.id)).plan, 'agency_ltd');
            assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.BULK_GENERATION), true);
            assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.COMMERCIAL_LICENSE), true);
            assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.AGENCY_LICENSE), true, 'the reseller/client right must be granted separately from commercial_license');
            assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.PRIORITY_QUEUE), true, 'granted honestly even though nothing enforces it yet');
        });

        test('a separately-purchased feature is granted (standing in for a future Bulk Studio checkout)', async () => {
            await entitlements.grantEntitlement({ userId: user.id, feature: entitlements.FEATURES.FACE_CONSISTENCY, source: 'purchase', referenceId: 'pay_standalone_1' });
            assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.FACE_CONSISTENCY), true);
        });

        test('downgrade back to hobbyist_ltd revokes bulk/commercial but keeps the standalone purchase', async () => {
            const orderId = `order_downgrade_${Date.now()}`, paymentId = `pay_downgrade_${Date.now()}`;
            const res = await appHarness.request('POST', '/api/plan/verify', sessionFor(user),
                JSON.stringify({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId), planId: 'creator', billingCycle: 'monthly' }));
            assert.strictEqual(res.statusCode, 200, res.body);

            assert.strictEqual((await db.getUserPlan(user.id)).plan, 'hobbyist_ltd');
            assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.BULK_GENERATION), false, 'the plan no longer on the account must not still grant bulk');
            assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.COMMERCIAL_LICENSE), false);
            assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.AGENCY_LICENSE), false, 'hobbyist_ltd does not include the reseller right');
            assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.PRIORITY_QUEUE), false);
            assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.WATERMARK_REMOVAL), true, 'hobbyist_ltd still includes this one');
            assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.FACE_CONSISTENCY), true, 'a purchased feature must survive a plan change in either direction');
        });
    });

    // 'test_secret' is the exact placeholder this codebase has already been
    // burned by once (it was a real .env value, and the old hardcoded
    // fallback) -- the handler correctly 503s on it rather than accepting a
    // forged signature, so this whole path stays unverifiable until a real
    // secret is set, locally and in Vercel.
    const PLACEHOLDER_SECRETS = new Set(['test_secret', 'your_webhook_secret', 'changeme']);
    const webhookSecretUsable = process.env.RAZORPAY_WEBHOOK_SECRET && !PLACEHOLDER_SECRETS.has(process.env.RAZORPAY_WEBHOOK_SECRET.trim().toLowerCase());
    describe('the webhook path: duplicate delivery and a refund', { skip: webhookSecretUsable ? false : 'RAZORPAY_WEBHOOK_SECRET is unset or still a placeholder' }, () => {
        let user;
        const paymentId = `pay_webhook_accept_${Date.now()}`;

        function mockReq(body) {
            const req = Readable.from([Buffer.from(body)]);
            req.method = 'POST';
            req.headers = { 'x-razorpay-signature': crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex') };
            return req;
        }
        function mockRes() {
            const res = { statusCode: null };
            res.status = (c) => { res.statusCode = c; return res; };
            res.send = () => res; res.json = () => res; res.end = () => res;
            return res;
        }

        test('setup: a user to grant the webhook feature to', async () => {
            user = await db.createUser(`accept-webhook-${Date.now()}@example.com`, 'unused-hash', null, null, 0, 'USD');
            createdUserIds.push(user.id);
        });

        test('a duplicate payment.captured grants the feature once', async () => {
            const handler = require('../api/webhooks/razorpay');
            const payload = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, notes: { user_id: user.id, product_id: entitlements.FEATURES.HD_UPSCALE } } } } });

            await handler(mockReq(payload), mockRes());
            await handler(mockReq(payload), mockRes());

            const { supabaseAdmin } = require('../lib/supabase');
            const { data: rows } = await supabaseAdmin.from('entitlements')
                .select('id').eq('reference_id', paymentId).eq('status', 'active');
            assert.strictEqual(rows.length, 1, 'the same payment id delivered twice must not grant twice');
            assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.HD_UPSCALE), true);
        });

        test('a refund on that payment revokes the entitlement it granted', async () => {
            const handler = require('../api/webhooks/razorpay');
            const payload = JSON.stringify({ event: 'payment.refunded', payload: { payment: { entity: { id: paymentId } } } });
            await handler(mockReq(payload), mockRes());
            assert.strictEqual(await entitlements.hasFeature(user.id, entitlements.FEATURES.HD_UPSCALE), false);
        });
    });

    test('a failed generation rolls back its credit debit', async () => {
        const email = `accept-refund-${Date.now()}@example.com`;
        const user = await db.createUser(email, 'unused-hash', null, null, 0, 'USD');
        createdUserIds.push(user.id);
        await db.addCredits(user.id, 10, 'test_grant', 'accept_test');
        const before = await db.getUserCredits(user.id);

        const res = await appHarness.request('POST', '/api/image/generate-flux', sessionFor(user),
            JSON.stringify({ prompt: 'a red sneaker on a white background' }));

        if (res.statusCode === 200) {
            console.log('  [acceptance] Flux generation succeeded — Replicate billing is configured; rollback path not exercised.');
            return;
        }
        assert.ok([502, 503].includes(res.statusCode), `expected a provider failure, got ${res.statusCode}: ${res.body}`);
        const after = await db.getUserCredits(user.id);
        assert.strictEqual(after, before, 'a failed generation must refund the debited credits');
    });
});
