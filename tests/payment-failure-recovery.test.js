// tests/payment-failure-recovery.test.js
// Regression test suite for payment recovery and fulfillment integrity:
// 1. Successful plan verification returns 200 with upscale_credits_added (no planConfig reference error)
// 2. Partial-failure retry during plan activation does not duplicate starter credits
// 3. Webhook retries resume unfinished activation and do not acknowledge unfulfilled payments
// 4. Guest checkout auto-registration calls valid credentials email and completes fulfillment
// 5. Agency ($197) acquisition orders derive and activate agency_ltd, never hobbyist_ltd

const { test, describe, after, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'recovery-test-jwt-secret';
process.env.RAZORPAY_KEY_SECRET = 'recovery-test-payment-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'recovery-test-webhook-secret';

const harness = require('./helpers/app');
const db = require('../database');
const entitlements = require('../lib/entitlements');
const referrals = require('../lib/referrals');
const email = require('../email');
const auth = require('../auth');
const webhook = require('../api/webhooks/razorpay');

after(async () => {
    await harness.stop();
});

afterEach(() => {
    mock.restoreAll();
});

function signPayment(orderId, paymentId) {
    return crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');
}

function signedWebhook(event) {
    const raw = Buffer.from(JSON.stringify(event));
    return {
        method: 'POST',
        body: raw,
        headers: {
            'x-razorpay-signature': crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
                .update(raw)
                .digest('hex')
        }
    };
}

function mockResponse() {
    return {
        statusCode: 200,
        body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
        send(b) { this.body = b; return this; },
        end() { return this; }
    };
}

describe('Payment Failure Recovery & Webhook Reconciliation', () => {
    test('1. successful plan verification returns 200 with valid upscale_credits_added', async () => {
        const user = { id: 'user_success', email: 'success@example.com' };
        const orderId = 'order_success_1';
        const paymentId = 'pay_success_1';
        let pending = { email: user.email, amount: 9700, currency: 'USD' };

        mock.method(db, 'claimPendingOrder', async () => { const o = pending; pending = null; return o; });
        mock.method(db, 'getUserByEmail', async () => user);
        mock.method(db, 'setUserPlan', async () => {});
        mock.method(db, 'recordPayment', async () => true);
        mock.method(db, 'initUserCredits', async () => 10);
        mock.method(db, 'addCredits', async () => 60);
        mock.method(entitlements, 'seedPlanEntitlements', async () => ['commercial_license']);
        mock.method(referrals, 'recordEligiblePayment', async () => {});

        const headers = {
            authorization: `Bearer ${jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET)}`,
            'content-type': 'application/json'
        };
        const body = JSON.stringify({
            razorpay_order_id: orderId,
            razorpay_payment_id: paymentId,
            razorpay_signature: signPayment(orderId, paymentId)
        });

        const res = await harness.request('POST', '/api/plan/verify', headers, body);
        assert.equal(res.statusCode, 200, res.body);
        const data = JSON.parse(res.body);
        assert.equal(data.success, true);
        assert.equal(data.plan, 'pro_founder_ltd');
        assert.equal(data.billing_cycle, 'lifetime');
        assert.equal(data.upscale_credits_added, 50);
    });

    test('2. partial-failure retry during plan activation does not duplicate starter credits', async () => {
        const user = { id: 'user_retry', email: 'retry@example.com' };
        const orderId = 'order_retry_2';
        const paymentId = 'pay_retry_2';
        let pending = { email: user.email, amount: 9700, currency: 'USD' };
        let credits = 0;
        let recordAttempts = 0;

        mock.method(db, 'claimPendingOrder', async () => { const o = pending; pending = null; return o; });
        mock.method(db, 'createPendingOrder', async (id, em, amt, cur) => { pending = { email: em, amount: amt, currency: cur }; });
        mock.method(db, 'getUserByEmail', async () => user);
        mock.method(db, 'setUserPlan', async () => {});
        mock.method(db, 'initUserCredits', async () => { credits += 10; return credits; });
        mock.method(db, 'addCredits', async (id, amt) => { credits += amt; return credits; });
        mock.method(db, 'recordPayment', async () => {
            if (++recordAttempts === 1) throw new Error('Injected ledger failure on first attempt');
            return true;
        });
        mock.method(entitlements, 'seedPlanEntitlements', async () => {});
        mock.method(referrals, 'recordEligiblePayment', async () => {});

        const headers = {
            authorization: `Bearer ${jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET)}`,
            'content-type': 'application/json'
        };
        const body = JSON.stringify({
            razorpay_order_id: orderId,
            razorpay_payment_id: paymentId,
            razorpay_signature: signPayment(orderId, paymentId)
        });

        // First attempt fails during ledger write before granting credits
        const first = await harness.request('POST', '/api/plan/verify', headers, body);
        assert.equal(first.statusCode, 500);

        // Second attempt (retry) succeeds and completes activation
        const second = await harness.request('POST', '/api/plan/verify', headers, body);
        assert.equal(second.statusCode, 200, second.body);

        // Expected credits: 10 (init) + 50 (pro plan) = 60 (NOT 120)
        assert.equal(credits, 60);
    });

    test('3. webhook retries resume unfinished activation and do not acknowledge unfulfilled payments', async () => {
        const user = { id: 'user_wh_retry', email: 'wh_retry@example.com' };
        let activationAttempts = 0;
        let paymentRecord = null;

        mock.method(db, 'getUserByEmail', async () => user);
        mock.method(db, 'getPendingOrder', async () => null);
        mock.method(db, 'setUserPlan', async () => {
            activationAttempts++;
            if (activationAttempts === 1) {
                throw new Error('Injected transient activation failure on first attempt');
            }
        });
        mock.method(db, 'initUserCredits', async () => 10);
        mock.method(db, 'addCredits', async () => 50);
        mock.method(db, 'recordPayment', async (rec) => { paymentRecord = rec; return true; });
        mock.method(entitlements, 'seedPlanEntitlements', async () => {});
        mock.method(referrals, 'recordEligiblePayment', async () => {});

        const event = {
            id: 'evt_retry_3',
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: {
                        id: 'pay_wh_retry',
                        order_id: 'order_wh_retry',
                        amount: 9700,
                        currency: 'USD',
                        notes: { userId: user.id, email: user.email, plan: 'pro_founder_ltd' }
                    }
                }
            }
        };

        // First webhook delivery fails mid-activation: returns 500, does NOT record completed payment
        const res1 = mockResponse();
        await webhook(signedWebhook(event), res1);
        assert.equal(res1.statusCode, 500);
        assert.equal(paymentRecord, null, 'Payment must NOT be recorded as fulfilled if activation threw');

        // Second webhook delivery retries activation: succeeds and returns 200
        const res2 = mockResponse();
        await webhook(signedWebhook(event), res2);
        assert.equal(res2.statusCode, 200);
        assert.equal(activationAttempts, 2, 'Webhook retry must resume and attempt activation again');
        assert.notEqual(paymentRecord, null, 'Payment must be recorded once fulfillment completes');
        assert.equal(paymentRecord.status, 'fulfilled');
    });

    test('4. guest checkout auto-registration calls valid credentials email without throwing', async () => {
        const emailAddress = 'guest_buyer@example.com';
        const user = { id: 'guest_user_4', email: emailAddress };
        let emailSent = false;
        let planActivated = null;

        mock.method(db, 'getPendingOrder', async () => null);
        mock.method(auth, 'registerUser', async () => ({ email: emailAddress, password: 'generated-pass' }));
        mock.method(db, 'getUserByEmail', async (em) => (em === emailAddress ? user : null));
        mock.method(email, 'sendCredentialsEmail', async (em, pass) => {
            assert.equal(em, emailAddress);
            assert.equal(pass, 'generated-pass');
            emailSent = true;
            return true;
        });
        mock.method(db, 'setUserPlan', async (uid, plan) => { planActivated = plan; });
        mock.method(db, 'initUserCredits', async () => 10);
        mock.method(db, 'addCredits', async () => 0);
        mock.method(db, 'recordPayment', async () => true);
        mock.method(entitlements, 'seedPlanEntitlements', async () => {});

        const event = {
            id: 'evt_guest_4',
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: {
                        id: 'pay_guest_4',
                        order_id: 'order_guest_4',
                        amount: 4700,
                        currency: 'USD',
                        notes: { type: 'acquisition_lifetime', email: emailAddress, plan: 'hobbyist_ltd' }
                    }
                }
            }
        };

        const res = mockResponse();
        await webhook(signedWebhook(event), res);
        assert.equal(res.statusCode, 200);
        assert.equal(emailSent, true, 'sendCredentialsEmail must be called without throwing');
        assert.equal(planActivated, 'hobbyist_ltd');
    });

    test('5. agency ($197) acquisition order activates agency_ltd, never hobbyist_ltd', async () => {
        const user = { id: 'user_agency_5', email: 'agency_buyer@example.com' };
        let activatedPlan = null;

        mock.method(db, 'getUserByEmail', async () => user);
        mock.method(db, 'getPendingOrder', async () => ({ email: user.email, amount: 19700, currency: 'USD' }));
        mock.method(db, 'setUserPlan', async (uid, plan) => { activatedPlan = plan; });
        mock.method(db, 'initUserCredits', async () => 10);
        mock.method(db, 'addCredits', async () => 120);
        mock.method(db, 'deletePendingOrder', async () => {});
        mock.method(db, 'recordPayment', async () => true);
        mock.method(entitlements, 'seedPlanEntitlements', async () => {});
        mock.method(referrals, 'recordEligiblePayment', async () => {});

        // Even if notes mistakenly said hobbyist_ltd, the verified order and payment amount of $197 must activate agency_ltd
        const event = {
            id: 'evt_agency_5',
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: {
                        id: 'pay_agency_5',
                        order_id: 'order_agency_5',
                        amount: 19700,
                        currency: 'USD',
                        notes: { userId: user.id, type: 'acquisition_lifetime', email: user.email, plan: 'hobbyist_ltd' }
                    }
                }
            }
        };

        const res = mockResponse();
        await webhook(signedWebhook(event), res);
        assert.equal(res.statusCode, 200);
        assert.equal(activatedPlan, 'agency_ltd', '$197 acquisition payment must activate agency_ltd');
    });

    test('6. fulfillment status persistence and plan ranking prevent late events from downgrading accounts', async () => {
        const user = { id: 'user_upgrade_6', email: 'upgrade@example.com' };
        let activePlan = 'agency_ltd';
        let setUserPlanCalls = 0;

        mock.method(db, 'getUserByEmail', async () => user);
        mock.method(db, 'getUserPlan', async () => ({ plan: activePlan }));
        mock.method(db, 'setUserPlan', async (uid, plan) => {
            setUserPlanCalls++;
            activePlan = plan;
        });
        mock.method(db, 'initUserCredits', async () => 10);
        mock.method(db, 'addCredits', async () => 50);
        mock.method(db, 'recordPayment', async () => true);
        mock.method(entitlements, 'seedPlanEntitlements', async () => {});
        mock.method(referrals, 'recordEligiblePayment', async () => {});

        // Delayed webhook arrives for an older Pro ($97) order while user is already on Agency ($197)
        const event = {
            id: 'evt_delayed_pro_6',
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: {
                        id: 'pay_delayed_pro_6',
                        order_id: 'order_delayed_pro_6',
                        amount: 9700,
                        currency: 'USD',
                        notes: { userId: user.id, email: user.email, plan: 'pro_founder_ltd' }
                    }
                }
            }
        };

        const res = mockResponse();
        await webhook(signedWebhook(event), res);
        assert.equal(res.statusCode, 200);
        // Plan must NOT downgrade from agency_ltd to pro_founder_ltd
        assert.equal(activePlan, 'agency_ltd', 'User plan must remain agency_ltd and not downgrade');
        assert.equal(setUserPlanCalls, 0, 'setUserPlan must not be called when delayed event is for lower tier');
    });

    test('7. required feature grant failure returns 500, preserves unfulfilled state, and resumes on retry', async () => {
        const user = { id: 'user_feat_fail_7', email: 'feat_fail@example.com' };
        let entitlementAttempts = 0;
        let paymentRecorded = false;

        mock.method(db, 'getUserByEmail', async () => user);
        mock.method(db, 'getPendingOrder', async () => null);
        mock.method(db, 'getUserPlan', async () => ({ plan: 'free_explorer' }));
        mock.method(db, 'setUserPlan', async () => {});
        mock.method(db, 'initUserCredits', async () => 10);
        mock.method(db, 'addCredits', async () => 50);
        mock.method(db, 'recordPayment', async () => { paymentRecorded = true; return true; });
        mock.method(entitlements, 'seedPlanEntitlements', async () => {
            entitlementAttempts++;
            if (entitlementAttempts === 1) {
                throw new Error('Injected failure during required plan entitlement grant');
            }
            return ['commercial_license', 'watermark_removal'];
        });

        const event = {
            id: 'evt_feat_7',
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: {
                        id: 'pay_feat_7',
                        order_id: 'order_feat_7',
                        amount: 9700,
                        currency: 'USD',
                        notes: { userId: user.id, email: user.email, plan: 'pro_founder_ltd' }
                    }
                }
            }
        };

        // Attempt 1: required entitlement fails -> returns 500, payment NOT recorded as fulfilled
        const res1 = mockResponse();
        await webhook(signedWebhook(event), res1);
        assert.equal(res1.statusCode, 500);
        assert.equal(paymentRecorded, false, 'Payment must NOT be recorded as fulfilled when required grant fails');

        // Attempt 2 (retry): entitlement succeeds -> returns 200, payment recorded
        const res2 = mockResponse();
        await webhook(signedWebhook(event), res2);
        assert.equal(res2.statusCode, 200);
        assert.equal(entitlementAttempts, 2, 'Retry must re-attempt the required entitlement grant');
        assert.equal(paymentRecorded, true, 'Payment must be recorded once all required grants complete');
    });

    test('8. concurrent initUserCredits calls coalesce and grant exactly one 10-credit signup bonus', async () => {
        const testUserId = 'user_concurrent_bonus_' + Date.now();
        let addCreditsCalls = 0;
        let creditsBalance = 0;

        mock.method(db, 'getUserCredits', async () => creditsBalance);
        mock.method(db, 'addCredits', async (uid, amount, source, refId) => {
            addCreditsCalls++;
            // Simulate slight async latency during database insert
            await new Promise(r => setTimeout(r, 10));
            creditsBalance += amount;
            return creditsBalance;
        });

        // Trigger two concurrent bonus initializations for the same user
        const results = await Promise.all([
            db.initUserCredits(testUserId),
            db.initUserCredits(testUserId)
        ]);

        assert.equal(addCreditsCalls, 1, 'addCredits must be called exactly once despite concurrent initialization');
        assert.equal(results[0], 10, 'First caller receives 10 credits');
        assert.equal(results[1], 10, 'Second caller receives 10 credits');
        assert.equal(creditsBalance, 10, 'Final credit balance must be exactly 10 (not 20)');
    });

    test('9. recordPayment preserves financial captured status and separate fulfilled fulfillment_status', async () => {
        let upsertedRow = null;
        const fakeSupabase = {
            from: (tbl) => ({
                upsert: async (row) => {
                    upsertedRow = row;
                    return { data: row, error: null };
                }
            })
        };

        const sb = require('../lib/supabase');
        const origAdmin = sb.supabaseAdmin;
        sb.supabaseAdmin = fakeSupabase;
        try {
            await db.recordPayment({
                paymentId: 'pay_contract_test',
                orderId: 'order_contract_test',
                userId: 'user_contract_test',
                email: 'contract@example.com',
                kind: 'plan',
                planId: 'pro_founder_ltd',
                amount: 9700,
                currency: 'USD',
                status: 'fulfilled'
            });

            assert.notEqual(upsertedRow, null);
            assert.equal(upsertedRow.status, 'captured', 'Financial status must be captured for revenue calculation');
            assert.equal(upsertedRow.fulfillment_status, 'fulfilled', 'Fulfillment state must be preserved as fulfilled');
        } finally {
            sb.supabaseAdmin = origAdmin;
        }
    });
});
