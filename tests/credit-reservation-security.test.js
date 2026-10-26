const { test, describe } = require('node:test');
const assert = require('node:assert');
const db = require('../database');

describe('credit reservation invariants & idempotency', () => {
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
});
