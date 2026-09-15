// tests/referrals.test.js
//
// The 10 acceptance tests from the Partner Program spec (Release D), run
// against the real (migrated) database. These are the hard boundary --
// nothing about a partner dashboard or a payout API is tested here on
// purpose, because none of it exists yet and none of it is required to
// prove the ledger is correct.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');

require('dotenv').config();

const HAS_CONFIG = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.JWT_SECRET);
const skip = HAS_CONFIG ? false : 'requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and JWT_SECRET';

const db = require('../database');
const referrals = require('../lib/referrals');
const { supabaseAdmin } = require('../lib/supabase');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const webhook = fs.readFileSync(path.join(__dirname, '..', 'api', 'webhooks', 'razorpay.js'), 'utf8');

describe('commission recording is wired into every commissionable payment site', () => {
    test('/api/plan/verify records an eligible commission alongside the payment', () => {
        const start = server.indexOf("app.post('/api/plan/verify'");
        const end = server.indexOf("app.post(", start + 10);
        const route = server.slice(start, end === -1 ? start + 4000 : end);
        assert.ok(route.includes('referrals.recordEligiblePayment'), 'plan upgrades must be checked for an eligible commission');
    });

    test('/api/payment/verify (the $47 lifetime purchase) does the same', () => {
        const start = server.indexOf("app.post('/api/payment/verify'");
        const end = server.indexOf("app.post(", start + 10);
        const route = server.slice(start, end === -1 ? start + 4000 : end);
        assert.ok(route.includes('referrals.recordEligiblePayment'), 'the primary acquisition purchase must be checked for an eligible commission');
    });

    test('the refund webhook reverses commissions the same way it revokes entitlements', () => {
        assert.ok(webhook.includes('reverseCommissionsForPayment'), 'a refund must reverse any commission it generated');
    });
});

const createdUserIds = [];
after(async () => {
    for (const id of createdUserIds) await db.deleteUser(id).catch(() => {});
});

async function makeUser(label) {
    const user = await db.createUser(`referral-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, 'unused-hash', null, null, 0, 'USD');
    createdUserIds.push(user.id);
    return user;
}

describe('Partner Program acceptance tests', { skip }, () => {
    // Test 1 -- Partner A -> Customer B -> $197 purchase -> $39.40 commission.
    test('1. a normal referral produces the canonical commission', async () => {
        const partnerA = await makeUser('t1-partner');
        const customerB = await makeUser('t1-customer');
        const code = await referrals.getOrCreateReferralCode(partnerA.id);

        await referrals.attributeReferral({ referralCode: code, referredUserId: customerB.id });

        const paymentId = `pay_t1_${Date.now()}`;
        const commission = await referrals.recordEligiblePayment({
            userId: customerB.id, paymentId, orderId: `order_t1_${Date.now()}`,
            kind: 'plan', planId: 'agency_ltd', grossAmountCents: 19700, currency: 'USD'
        });

        assert.ok(commission, 'a commission must be created');
        assert.strictEqual(commission.partner_id, partnerA.id);
        assert.strictEqual(commission.commission_amount, 3940);
        assert.strictEqual(commission.commission_type, 'initial');
        assert.strictEqual(commission.status, 'pending');
    });

    // Test 2 -- the same Razorpay payment processed twice must produce ONE commission.
    test('2. a duplicate payment does not double the commission', async () => {
        const partnerA = await makeUser('t2-partner');
        const customerB = await makeUser('t2-customer');
        const code = await referrals.getOrCreateReferralCode(partnerA.id);
        await referrals.attributeReferral({ referralCode: code, referredUserId: customerB.id });

        const paymentId = `pay_t2_${Date.now()}`;
        const args = { userId: customerB.id, paymentId, orderId: `order_t2_${Date.now()}`, kind: 'plan', planId: 'agency_ltd', grossAmountCents: 19700, currency: 'USD' };

        const first = await referrals.recordEligiblePayment(args);
        const second = await referrals.recordEligiblePayment(args); // same paymentId, simulating a webhook retry

        assert.ok(first, 'the first call must create a commission');
        assert.strictEqual(second, null, 'the retried call must not create a second one');

        const { data: rows } = await supabaseAdmin.from('commissions').select('id').eq('payment_id', paymentId);
        assert.strictEqual(rows.length, 1);
    });

    // Test 3 -- a refund before the hold window clears reverses the commission.
    test('3. a refund before 30 days reverses a pending commission', async () => {
        const partnerA = await makeUser('t3-partner');
        const customerB = await makeUser('t3-customer');
        const code = await referrals.getOrCreateReferralCode(partnerA.id);
        await referrals.attributeReferral({ referralCode: code, referredUserId: customerB.id });

        const paymentId = `pay_t3_${Date.now()}`;
        const commission = await referrals.recordEligiblePayment({
            userId: customerB.id, paymentId, orderId: `order_t3_${Date.now()}`,
            kind: 'plan', planId: 'agency_ltd', grossAmountCents: 19700, currency: 'USD'
        });
        assert.strictEqual(commission.status, 'pending');

        const { reversed } = await referrals.reverseCommissionsForPayment(paymentId);
        assert.strictEqual(reversed, 1);

        const { data: row } = await supabaseAdmin.from('commissions').select('status').eq('payment_id', paymentId).maybeSingle();
        assert.strictEqual(row.status, 'reversed');
    });

    // Test 4 -- a refund after the commission has already been paid out is
    // flagged for manual clawback, not silently reversed.
    test('4. a refund after payout is flagged, not auto-reversed', async () => {
        const partnerA = await makeUser('t4-partner');
        const customerB = await makeUser('t4-customer');
        const code = await referrals.getOrCreateReferralCode(partnerA.id);
        await referrals.attributeReferral({ referralCode: code, referredUserId: customerB.id });

        const paymentId = `pay_t4_${Date.now()}`;
        const commission = await referrals.recordEligiblePayment({
            userId: customerB.id, paymentId, orderId: `order_t4_${Date.now()}`,
            kind: 'plan', planId: 'agency_ltd', grossAmountCents: 19700, currency: 'USD'
        });
        // markPaid only moves 'available' -> 'paid'; force the row there first
        // to isolate what this test is actually about (the refund-after-paid
        // behavior), not the hold-window timer.
        await supabaseAdmin.from('commissions').update({ status: 'available' }).eq('id', commission.id);
        await referrals.markPaid({ commissionIds: [commission.id], payoutReference: 'manual-test', payoutMethod: 'bank' });

        const { reversed, needsClawback } = await referrals.reverseCommissionsForPayment(paymentId);
        assert.strictEqual(reversed, 0, 'a paid commission must not be silently reversed');
        assert.strictEqual(needsClawback, 1);

        const { data: row } = await supabaseAdmin.from('commissions').select('status').eq('payment_id', paymentId).maybeSingle();
        assert.strictEqual(row.status, 'paid', 'status stays paid -- clawback is a manual action, not automatic');
    });

    // Test 5 -- a partner cannot refer their own account.
    test('5. self-referral produces no referral and no commission', async () => {
        const partnerA = await makeUser('t5-partner');
        const code = await referrals.getOrCreateReferralCode(partnerA.id);

        const result = await referrals.attributeReferral({ referralCode: code, referredUserId: partnerA.id });
        assert.strictEqual(result, null);

        const commission = await referrals.recordEligiblePayment({
            userId: partnerA.id, paymentId: `pay_t5_${Date.now()}`, orderId: `order_t5_${Date.now()}`,
            kind: 'plan', planId: 'agency_ltd', grossAmountCents: 19700, currency: 'USD'
        });
        assert.strictEqual(commission, null);
    });

    // Test 6 -- first valid attribution wins for the life of the customer.
    test('6. a later click from a second partner does not re-attribute', async () => {
        const partnerA = await makeUser('t6-partnerA');
        const partnerB = await makeUser('t6-partnerB');
        const customerB = await makeUser('t6-customer');
        const codeA = await referrals.getOrCreateReferralCode(partnerA.id);
        const codeB = await referrals.getOrCreateReferralCode(partnerB.id);

        const first = await referrals.attributeReferral({ referralCode: codeA, referredUserId: customerB.id });
        const second = await referrals.attributeReferral({ referralCode: codeB, referredUserId: customerB.id });

        assert.ok(first, 'the first attribution must succeed');
        assert.strictEqual(second, null, 'a second partner cannot re-attribute an already-attributed customer');

        const commission = await referrals.recordEligiblePayment({
            userId: customerB.id, paymentId: `pay_t6_${Date.now()}`, orderId: `order_t6_${Date.now()}`,
            kind: 'plan', planId: 'agency_ltd', grossAmountCents: 19700, currency: 'USD'
        });
        assert.strictEqual(commission.partner_id, partnerA.id, 'Partner A must retain attribution and the commission');
    });

    // Test 7 -- a non-commissionable SKU (a credit pack) never produces a
    // commission, even with a valid, active referral in place.
    test('7. a credit-pack purchase is never commissioned', async () => {
        const partnerA = await makeUser('t7-partner');
        const customerB = await makeUser('t7-customer');
        const code = await referrals.getOrCreateReferralCode(partnerA.id);
        await referrals.attributeReferral({ referralCode: code, referredUserId: customerB.id });

        const commission = await referrals.recordEligiblePayment({
            userId: customerB.id, paymentId: `pay_t7_${Date.now()}`, orderId: `order_t7_${Date.now()}`,
            kind: 'credits', planId: null, grossAmountCents: 500000, currency: 'INR'
        });
        assert.strictEqual(commission, null);
    });

    // Test 8 -- a recurring purchase within the 12-month window earns 10%.
    test('8. a recurring purchase within 12 months earns the recurring rate', async () => {
        const partnerA = await makeUser('t8-partner');
        const customerB = await makeUser('t8-customer');
        const code = await referrals.getOrCreateReferralCode(partnerA.id);
        await referrals.attributeReferral({ referralCode: code, referredUserId: customerB.id });

        await referrals.recordEligiblePayment({
            userId: customerB.id, paymentId: `pay_t8_initial_${Date.now()}`, orderId: `order_t8a_${Date.now()}`,
            kind: 'plan', planId: 'agency_ltd', grossAmountCents: 19700, currency: 'USD'
        });

        const recurring = await referrals.recordEligiblePayment({
            userId: customerB.id, paymentId: `pay_t8_recurring_${Date.now()}`, orderId: `order_t8b_${Date.now()}`,
            kind: 'plan', planId: 'agency_pro', grossAmountCents: 4900, currency: 'USD'
        });
        assert.ok(recurring);
        assert.strictEqual(recurring.commission_type, 'recurring');
        assert.strictEqual(recurring.commission_amount, 490);
    });

    // Test 9 -- outside the 12-month recurring window, no commission.
    test('9. a purchase after the 12-month recurring window earns nothing', async () => {
        const partnerA = await makeUser('t9-partner');
        const customerB = await makeUser('t9-customer');
        const code = await referrals.getOrCreateReferralCode(partnerA.id);
        const referral = await referrals.attributeReferral({ referralCode: code, referredUserId: customerB.id });

        // Establish the first conversion, then backdate it 13 months --
        // simulating "month 13" without waiting 13 months for the test to run.
        await referrals.recordEligiblePayment({
            userId: customerB.id, paymentId: `pay_t9_initial_${Date.now()}`, orderId: `order_t9a_${Date.now()}`,
            kind: 'plan', planId: 'agency_ltd', grossAmountCents: 19700, currency: 'USD'
        });
        const thirteenMonthsAgo = new Date(Date.now() - 13 * 30 * 24 * 60 * 60 * 1000).toISOString();
        await supabaseAdmin.from('referrals').update({ converted_at: thirteenMonthsAgo }).eq('id', referral.id);

        const late = await referrals.recordEligiblePayment({
            userId: customerB.id, paymentId: `pay_t9_late_${Date.now()}`, orderId: `order_t9b_${Date.now()}`,
            kind: 'plan', planId: 'agency_pro', grossAmountCents: 4900, currency: 'USD'
        });
        assert.strictEqual(late, null, 'month 13 must not earn a commission');
    });

    // Test 10 -- the minimum payout threshold.
    test('10. payout eligibility respects the $25 minimum', async () => {
        const partnerA = await makeUser('t10-partner');
        const customerB = await makeUser('t10-customer');
        const code = await referrals.getOrCreateReferralCode(partnerA.id);
        await referrals.attributeReferral({ referralCode: code, referredUserId: customerB.id });

        // hobbyist_ltd @ $49 -> $9.80 commission: below the $25 minimum on its own.
        const small = await referrals.recordEligiblePayment({
            userId: customerB.id, paymentId: `pay_t10_small_${Date.now()}`, orderId: `order_t10a_${Date.now()}`,
            kind: 'plan', planId: 'hobbyist_ltd', grossAmountCents: 4900, currency: 'USD'
        });
        // Force it available (bypassing the 30-day hold) to test the threshold itself, not the hold timer.
        await supabaseAdmin.from('commissions').update({ status: 'available' }).eq('id', small.id);

        let summary = await referrals.getPartnerSummary(partnerA.id);
        assert.strictEqual(summary.payoutEligible, false, `$${summary.availableCents / 100} must be below the $25 minimum`);

        // A second referred customer's agency_ltd commission ($39.40) pushes the partner over the threshold.
        const customerC = await makeUser('t10-customerC');
        await referrals.attributeReferral({ referralCode: code, referredUserId: customerC.id });
        const big = await referrals.recordEligiblePayment({
            userId: customerC.id, paymentId: `pay_t10_big_${Date.now()}`, orderId: `order_t10b_${Date.now()}`,
            kind: 'plan', planId: 'agency_ltd', grossAmountCents: 19700, currency: 'USD'
        });
        await supabaseAdmin.from('commissions').update({ status: 'available' }).eq('id', big.id);

        summary = await referrals.getPartnerSummary(partnerA.id);
        assert.strictEqual(summary.payoutEligible, true, `$${summary.availableCents / 100} must clear the $25 minimum`);
        assert.strictEqual(summary.availableCents, 980 + 3940);
    });
});
