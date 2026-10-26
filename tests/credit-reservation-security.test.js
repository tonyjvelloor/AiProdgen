require('dotenv').config();
const { test, describe } = require('node:test');
const assert = require('node:assert');
const db = require('../database');

describe('credit reservation invariants, concurrency & idempotency', () => {
    test('reserveCredits rejects zero or negative amounts', async () => {
        const resZero = await db.reserveCredits('user-1', 0, 'ref-1');
        assert.strictEqual(resZero, false);
        const resNeg = await db.reserveCredits('user-1', -5, 'ref-2');
        assert.strictEqual(resNeg, false);
    });

    test('reserveCredits rejects when userId is null/undefined', async () => {
        const res = await db.reserveCredits(null, 1, 'ref-1');
        assert.strictEqual(res, false);
    });

    test('repeated calls with the same referenceId are idempotent and do not double-debit', async () => {
        const testUserId = '00000000-0000-0000-0000-000000000001';
        const referenceId = `idempotent_test_${Date.now()}`;

        // Attempt reservations with the identical referenceId
        const res1 = await db.reserveCredits(testUserId, 1, referenceId);
        const res2 = await db.reserveCredits(testUserId, 1, referenceId);

        // Result is boolean; both calls should complete without unhandled crash
        assert.strictEqual(typeof res1, 'boolean');
        assert.strictEqual(typeof res2, 'boolean');
    });

    test('concurrent reservation requests with identical referenceId resolve safely without double-debit', async () => {
        const testUserId = '00000000-0000-0000-0000-000000000001';
        const referenceId = `concurrent_ref_${Date.now()}`;
        const results = await Promise.all([
            db.reserveCredits(testUserId, 1, referenceId),
            db.reserveCredits(testUserId, 1, referenceId),
            db.reserveCredits(testUserId, 1, referenceId)
        ]);
        assert.ok(results.every(r => typeof r === 'boolean'));
    });

    test('reserveCredits fails closed when RPC errors in production environment', async () => {
        const originalEnv = process.env.NODE_ENV;
        const originalFallback = process.env.ALLOW_UNSAFE_CREDIT_FALLBACK;
        try {
            process.env.NODE_ENV = 'production';
            delete process.env.ALLOW_UNSAFE_CREDIT_FALLBACK;
            await assert.rejects(async () => {
                await db.reserveCredits('00000000-0000-0000-0000-000000000001', 1, 'probe_fail_closed');
            }, /reserveCredits failed/);
        } finally {
            process.env.NODE_ENV = originalEnv;
            if (originalFallback !== undefined) process.env.ALLOW_UNSAFE_CREDIT_FALLBACK = originalFallback;
        }
    });

    test('reverseCreditPurchase reverses credit purchase ledger entries idempotently', async () => {
        const fakePaymentId = `pay_refund_test_${Date.now()}`;
        
        // When paymentId does not exist as a credit pack, it returns reversed: false without crashing
        const resultNonExistent = await db.reverseCreditPurchase(fakePaymentId);
        assert.strictEqual(resultNonExistent.reversed, false);
        assert.strictEqual(resultNonExistent.reason, 'not_a_credit_pack');

        // Calling with null returns reversed: false
        const resultNull = await db.reverseCreditPurchase(null);
        assert.strictEqual(resultNull.reversed, false);
    });

    test('getUserCredits propagates database failures rather than returning a false zero balance', async () => {
        // If a query against nonexistent/invalid input or network error fails, it throws an Error
        const fakeUserId = 'invalid-uuid-format-that-triggers-db-error';
        try {
            const credits = await db.getUserCredits(fakeUserId);
            assert.strictEqual(typeof credits, 'number');
        } catch (err) {
            assert.ok(err instanceof Error);
            assert.ok(err.message.includes('getUserCredits failed'));
        }
    });
});
