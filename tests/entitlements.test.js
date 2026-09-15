const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config();

const HAS_CONFIG = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.JWT_SECRET);
const skip = HAS_CONFIG ? false : 'requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and JWT_SECRET';

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// PLANS has always carried bulk/commercial/watermark/templates flags that no
// route read. These checks guard that both places a plan gets activated
// actually derive feature grants from it, instead of the flags staying inert.
describe('plan activation seeds feature entitlements', () => {
    test('/api/plan/verify seeds entitlements after activating the plan', () => {
        const start = server.indexOf("app.post('/api/plan/verify'");
        const end = server.indexOf("app.post(", start + 10);
        const route = server.slice(start, end === -1 ? start + 3000 : end);
        assert.ok(route.includes('db.setUserPlan'), 'route must activate the plan');
        assert.ok(route.includes('entitlements.seedPlanEntitlements'), 'route must seed feature grants for the new plan');
    });

    test('/api/payment/verify activates a paid plan, not just an account', () => {
        const start = server.indexOf("app.post('/api/payment/verify'");
        const end = server.indexOf("app.post(", start + 10);
        const route = server.slice(start, end === -1 ? start + 3000 : end);
        // createUser() never set a plan, so this route used to leave every
        // $47 lifetime buyer on the free_explorer default.
        assert.ok(route.includes('db.setUserPlan'), 'the lifetime purchase must activate a paid plan, not leave the default');
        assert.ok(route.includes('entitlements.seedPlanEntitlements'), 'the lifetime purchase must seed feature grants');
        assert.ok(route.includes('db.recordPayment'), 'the primary acquisition purchase must be recorded in the revenue ledger');
    });
});

// Agency Reseller V2, Release B. agency_license is a distinct right from
// commercial_license (§04/§08 of the spec) -- confirm the bundle and the
// backfill for pre-existing holders both exist.
describe('agency_ltd carries the Agency Reseller V2 bundle', () => {
    const entitlements = require('../lib/entitlements');

    test('AGENCY_LICENSE is a known feature, separate from COMMERCIAL_LICENSE', () => {
        assert.strictEqual(entitlements.FEATURES.AGENCY_LICENSE, 'agency_license');
        assert.notStrictEqual(entitlements.FEATURES.AGENCY_LICENSE, entitlements.FEATURES.COMMERCIAL_LICENSE);
    });

    test('PLANS.agency_ltd grants agency_license and priority, and caps starter credits at 120', () => {
        const start = server.indexOf('agency_ltd: {');
        const line = server.slice(start, server.indexOf('\n', start));
        assert.ok(line.includes('agency_license: true'), 'agency_ltd must include the reseller right');
        assert.ok(line.includes('priority: true'), 'agency_ltd must include priority (granted honestly, unenforced)');
        assert.ok(line.includes('upscale: 120'), 'starter credits must be the bounded 120, not the old 200');
    });

    test('a backfill script exists for holders who bought before this bundle existed', () => {
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'backfill_agency_license.js')));
    });
});

describe('entitlements module shape', () => {
    const entitlements = require('../lib/entitlements');
    test('exports the expected surface', () => {
        for (const fn of ['hasFeature', 'grantEntitlement', 'revokeEntitlement', 'revokeEntitlementByReference', 'consumeEntitlement', 'getUserEntitlements', 'requireFeature', 'seedPlanEntitlements']) {
            assert.strictEqual(typeof entitlements[fn], 'function', `entitlements.${fn} must be a function`);
        }
        assert.ok(entitlements.FEATURES && Object.keys(entitlements.FEATURES).length > 0, 'FEATURES must be populated');
        assert.ok(entitlements.SOURCES && Object.keys(entitlements.SOURCES).length > 0, 'SOURCES must be populated');
    });

    test('consumeEntitlement spends through the atomic Postgres function, not a JS read-then-write', () => {
        const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'entitlements.js'), 'utf8');
        const fn = lib.slice(lib.indexOf('async function consumeEntitlement'), lib.indexOf('async function getUserEntitlements'));
        assert.ok(fn.includes("supabaseAdmin.rpc('consume_entitlement'"), 'consumeEntitlement must call the row-locked SQL function, not decrement remaining_quantity from JS');
    });
});

// The webhook originally granted into `user_entitlements`, a table nothing
// ever read from -- see api/webhooks/razorpay.js. These guard the fix and
// the refund-revokes-access path the acceptance checklist calls for.
describe('the Razorpay webhook grants and revokes through the real entitlements module', () => {
    const webhook = fs.readFileSync(path.join(__dirname, '..', 'api', 'webhooks', 'razorpay.js'), 'utf8');

    test('payment.captured grants via entitlements.grantEntitlement, not the dead user_entitlements table', () => {
        assert.ok(webhook.includes('entitlements.grantEntitlement'), 'webhook must grant through the module routes also use');
        assert.ok(!webhook.includes(".from('user_entitlements')"), 'webhook must not write into the table nothing reads');
    });

    test('payment.refunded revokes the entitlement that payment granted', () => {
        assert.ok(webhook.includes("'payment.refunded'"), 'webhook must handle the refund event');
        assert.ok(webhook.includes('revokeEntitlementByReference'), 'a refund must revoke by payment id');
    });
});

describe('grant / consume / revoke against a real row', { skip }, () => {
    const entitlements = require('../lib/entitlements');
    const db = require('../database');
    let userId;

    test('setup: create a throwaway user', async () => {
        const user = await db.createUser(`entitlement-test-${Date.now()}@example.com`, 'unused-hash', null, null, 0, 'USD');
        userId = user.id;
        assert.ok(userId);
    });

    test('an unlimited grant is usable and never exhausts', async () => {
        await entitlements.grantEntitlement({ userId, feature: entitlements.FEATURES.COMMERCIAL_LICENSE, source: 'plan', referenceId: 'test_plan' });
        assert.strictEqual(await entitlements.hasFeature(userId, entitlements.FEATURES.COMMERCIAL_LICENSE), true);
        assert.strictEqual(await entitlements.consumeEntitlement(userId, entitlements.FEATURES.COMMERCIAL_LICENSE, 1000), true);
        assert.strictEqual(await entitlements.hasFeature(userId, entitlements.FEATURES.COMMERCIAL_LICENSE), true);
    });

    test('a quantity-limited grant decrements and refuses once exhausted', async () => {
        await entitlements.grantEntitlement({ userId, feature: entitlements.FEATURES.HD_UPSCALE, source: 'purchase', quantity: 3, referenceId: 'pay_test_1' });
        assert.strictEqual(await entitlements.consumeEntitlement(userId, entitlements.FEATURES.HD_UPSCALE, 2), true);
        assert.strictEqual(await entitlements.consumeEntitlement(userId, entitlements.FEATURES.HD_UPSCALE, 2), false, 'only 1 remains, spending 2 must fail and not partially consume');
        assert.strictEqual(await entitlements.consumeEntitlement(userId, entitlements.FEATURES.HD_UPSCALE, 1), true);
        assert.strictEqual(await entitlements.hasFeature(userId, entitlements.FEATURES.HD_UPSCALE), false, 'exhausted grant no longer counts as active');
    });

    test('a repeat purchase of the same feature stacks instead of being deduped away', async () => {
        await entitlements.grantEntitlement({ userId, feature: entitlements.FEATURES.BULK_GENERATION, source: 'purchase', quantity: 5, referenceId: 'pay_test_2' });
        await entitlements.grantEntitlement({ userId, feature: entitlements.FEATURES.BULK_GENERATION, source: 'purchase', quantity: 5, referenceId: 'pay_test_3' });
        assert.strictEqual(await entitlements.consumeEntitlement(userId, entitlements.FEATURES.BULK_GENERATION, 8), true, 'two 5-unit purchases must combine to 10');
    });

    test('revoke removes access immediately', async () => {
        await entitlements.revokeEntitlement(userId, entitlements.FEATURES.COMMERCIAL_LICENSE, 'plan');
        assert.strictEqual(await entitlements.hasFeature(userId, entitlements.FEATURES.COMMERCIAL_LICENSE), false);
    });

    test('seedPlanEntitlements reconciles a plan downgrade', async () => {
        const agencyLike = { bulk: true, commercial: true, watermark: false, templates: 'advanced' };
        const freeLike = { bulk: false, commercial: false, watermark: true, templates: 'none' };

        await entitlements.seedPlanEntitlements(userId, 'test_agency', agencyLike);
        assert.strictEqual(await entitlements.hasFeature(userId, entitlements.FEATURES.WATERMARK_REMOVAL), true);
        assert.strictEqual(await entitlements.hasFeature(userId, entitlements.FEATURES.PREMIUM_TEMPLATES), true);

        await entitlements.seedPlanEntitlements(userId, 'test_free', freeLike);
        assert.strictEqual(await entitlements.hasFeature(userId, entitlements.FEATURES.WATERMARK_REMOVAL), false, 'downgrade must revoke a plan-sourced feature the new plan does not include');
        assert.strictEqual(await entitlements.hasFeature(userId, entitlements.FEATURES.PREMIUM_TEMPLATES), false);
        // Purchase-sourced grants from earlier in this test must survive a plan change.
        assert.strictEqual(await entitlements.hasFeature(userId, entitlements.FEATURES.BULK_GENERATION), true, 'a purchased feature must not be revoked by a plan reseed');
    });

    // The acceptance test explicitly called for: remaining_quantity = 1, two
    // concurrent requests, exactly one must succeed. This is what the
    // Postgres function (not the old JS read-then-write) is for.
    test('two concurrent spends against the last unit: exactly one succeeds', async () => {
        await entitlements.grantEntitlement({ userId, feature: entitlements.FEATURES.PRIORITY_QUEUE, source: 'purchase', quantity: 1, referenceId: 'pay_race_1' });
        const [a, b] = await Promise.all([
            entitlements.consumeEntitlement(userId, entitlements.FEATURES.PRIORITY_QUEUE, 1),
            entitlements.consumeEntitlement(userId, entitlements.FEATURES.PRIORITY_QUEUE, 1)
        ]);
        assert.strictEqual([a, b].filter(Boolean).length, 1, `expected exactly one winner, got a=${a} b=${b}`);
        assert.strictEqual(await entitlements.hasFeature(userId, entitlements.FEATURES.PRIORITY_QUEUE), false, 'the single unit must now be exhausted');
    });

    test('a refund revokes the entitlement that payment granted, by payment id alone', async () => {
        await entitlements.grantEntitlement({ userId, feature: entitlements.FEATURES.BRAND_KIT, source: 'purchase', referenceId: 'pay_refund_test' });
        assert.strictEqual(await entitlements.hasFeature(userId, entitlements.FEATURES.BRAND_KIT), true);
        await entitlements.revokeEntitlementByReference('pay_refund_test');
        assert.strictEqual(await entitlements.hasFeature(userId, entitlements.FEATURES.BRAND_KIT), false);
    });

    test('a duplicate payment.captured-style grant for the same payment id does not stack', async () => {
        const first = await entitlements.grantEntitlement({ userId, feature: entitlements.FEATURES.WATERMARK_REMOVAL, source: 'purchase', quantity: 5, referenceId: 'pay_dup_test' });
        const second = await entitlements.grantEntitlement({ userId, feature: entitlements.FEATURES.WATERMARK_REMOVAL, source: 'purchase', quantity: 5, referenceId: 'pay_dup_test' });
        assert.strictEqual(first.id, second.id, 'retrying the same payment id must return the existing grant, not insert a second one');
        assert.strictEqual(await entitlements.consumeEntitlement(userId, entitlements.FEATURES.WATERMARK_REMOVAL, 6), false, 'only 5 units exist -- a duplicate grant would have made this 10');
    });

    test('requireFeature middleware blocks without the grant and passes with it', async () => {
        const middleware = entitlements.requireFeature(entitlements.FEATURES.FACE_CONSISTENCY);
        let nextCalled = false;
        let jsonBody = null;
        let statusCode = null;
        const res = { status(code) { statusCode = code; return this; }, json(body) { jsonBody = body; return this; } };

        await middleware({ user: { userId } }, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(statusCode, 402);
        assert.strictEqual(jsonBody.code, 'FEATURE_REQUIRED');

        await entitlements.grantEntitlement({ userId, feature: entitlements.FEATURES.FACE_CONSISTENCY, source: 'admin_grant', referenceId: 'test' });
        nextCalled = false;
        await middleware({ user: { userId } }, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true);
    });

    test('teardown: delete the throwaway user', async () => {
        if (userId) {
            const ok = await db.deleteUser(userId);
            assert.strictEqual(ok, true);
        }
    });
});
