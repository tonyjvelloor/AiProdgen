const { test, describe } = require('node:test');
const assert = require('node:assert');
const { calculateCommission, isCommissionable, INITIAL_RATE, RECURRING_RATE, RECURRING_MONTHS } = require('../lib/commissions');

// The canonical example from the spec: $197 Agency license, first purchase.
describe('the commission calculation contract', () => {
    test('the canonical example: $197 x 20% = $39.40', () => {
        const result = calculateCommission({ kind: 'plan', planId: 'agency_ltd', grossAmountCents: 19700, currency: 'USD' });
        assert.strictEqual(result.commissionable, true);
        assert.strictEqual(result.commissionAmountCents, 3940);
        assert.strictEqual(result.rate, INITIAL_RATE);
    });

    test('Creator ($47/$49) is commissionable at the same default rate', () => {
        const result = calculateCommission({ kind: 'plan', planId: 'hobbyist_ltd', grossAmountCents: 4900, currency: 'USD' });
        assert.strictEqual(result.commissionable, true);
        assert.strictEqual(result.commissionAmountCents, Math.round(4900 * INITIAL_RATE));
    });

    // Test 7 from the acceptance list: a credit pack must never commission,
    // regardless of amount -- this is the enforcement of "don't commission
    // the AI-compute pass-through."
    test('a credit pack is never commissionable, no matter the amount', () => {
        const result = calculateCommission({ kind: 'credits', planId: null, grossAmountCents: 500000, currency: 'INR' });
        assert.strictEqual(result.commissionable, false);
        assert.strictEqual(result.commissionAmountCents, 0);
    });

    test('an unlisted plan (a future feature unlock, say) defaults to not commissionable', () => {
        const result = calculateCommission({ kind: 'plan', planId: 'bulk_studio_unlock', grossAmountCents: 39900 });
        assert.strictEqual(result.commissionable, false);
    });

    // Test 8: a recurring purchase (Agency Pro, once it exists) earns the
    // lower rate -- the calculator takes commissionType as a fact handed to
    // it; deciding whether a given payment IS the recurring case belongs to
    // the ledger layer (lib/referrals.js), not here.
    test('commissionType: recurring applies the 10% rate', () => {
        const result = calculateCommission({ kind: 'plan', planId: 'agency_pro', grossAmountCents: 4900, commissionType: 'recurring' });
        assert.strictEqual(result.commissionable, true);
        assert.strictEqual(result.rate, RECURRING_RATE);
        assert.strictEqual(result.commissionAmountCents, 490);
    });

    test('a zero or negative amount is never commissionable', () => {
        for (const amount of [0, -100]) {
            const result = calculateCommission({ kind: 'plan', planId: 'agency_ltd', grossAmountCents: amount });
            assert.strictEqual(result.commissionable, false, `amount ${amount} must not commission`);
        }
    });

    test('the calculation is deterministic -- same input, same output, always', () => {
        const input = { kind: 'plan', planId: 'agency_ltd', grossAmountCents: 19700, currency: 'USD' };
        const a = calculateCommission(input);
        const b = calculateCommission(input);
        assert.deepStrictEqual(a, b);
    });

    test('isCommissionable is exact about kind -- "plan" only, never inferred', () => {
        assert.strictEqual(isCommissionable({ kind: 'plan', planId: 'agency_ltd' }), true);
        assert.strictEqual(isCommissionable({ kind: 'credits', planId: 'agency_ltd' }), false);
        assert.strictEqual(isCommissionable({ kind: undefined, planId: 'agency_ltd' }), false);
    });

    test('RECURRING_MONTHS is 12, as locked in the spec', () => {
        assert.strictEqual(RECURRING_MONTHS, 12);
    });
});
