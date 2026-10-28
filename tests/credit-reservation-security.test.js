const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
// These are unit contracts. A fake UUID against a live database cannot prove
// double-debit safety and must not modify a developer's real credit ledger.
const supabasePath = require.resolve('../lib/supabase');
let rpcResult = { data: true, error: null };
let queryResult = { data: null, error: null };
const calls = [];
const query = new Proxy({}, { get(_target, name) {
    if (name === 'then') return resolve => resolve(queryResult);
    return (...args) => { calls.push([name, ...args]); return query; };
} });
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: {
    isSupabaseConfigured: true,
    supabaseAdmin: { rpc: async (...args) => { calls.push(['rpc', ...args]); return rpcResult; }, from: () => query }
} };
const db = require('../database');
describe('credit reservation contracts without a live database', () => {
    test('rejects invalid amounts and missing users before RPC', async () => {
        calls.length = 0;
        for (const amount of [0, -1]) assert.equal(await db.reserveCredits('user', amount, 'run'), false);
        assert.equal(await db.reserveCredits(null, 1, 'run'), false);
        assert.equal(calls.length, 0);
    });
    test('uses the atomic database function with the same reference on retries', async () => {
        calls.length = 0;
        rpcResult = { data: true, error: null };
        assert.equal(await db.reserveCredits('user', 1, 'run'), true);
        assert.equal(await db.reserveCredits('user', 1, 'run'), true);
        assert.deepEqual(calls, Array(2).fill(['rpc', 'reserve_credits', { p_user_id: 'user', p_amount: 1, p_reference_id: 'run' }]));
    });
    test('does not bypass an atomic insufficient-balance result', async () => {
        rpcResult = { data: false, error: null };
        assert.equal(await db.reserveCredits('user', 1, 'run'), false);
    });
    test('fails closed on RPC errors in production', async () => {
        const original = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        rpcResult = { data: null, error: { message: 'unavailable', code: 'XX000' } };
        try { await assert.rejects(db.reserveCredits('user', 1, 'run'), /reserveCredits failed/); }
        finally { process.env.NODE_ENV = original; }
    });
    test('an unknown refunded payment cannot subtract credits', async () => {
        queryResult = { data: null, error: null };
        assert.equal((await db.reverseCreditPurchase('unknown')).reason, 'not_a_credit_pack');
        assert.equal((await db.reverseCreditPurchase(null)).reversed, false);
    });
    test('a failed balance query throws rather than inventing a zero balance', async () => {
        queryResult = { data: null, error: { message: 'database unavailable' } };
        await assert.rejects(db.getUserCredits('user'), /getUserCredits failed: database unavailable/);
    });
});
