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
});
