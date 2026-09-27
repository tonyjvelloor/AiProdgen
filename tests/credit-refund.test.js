const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Credits are debited before the provider call. When the provider then fails,
// the user has paid for a generation they never received. Five failed Flux
// calls during verification burned ten credits with zero refunds recorded.
describe('failed generations refund their credits', () => {
    test('providerFailure issues a rollback', () => {
        const fn = server.slice(server.indexOf('async function providerFailure'),
                                server.indexOf('// Helper: Check plan access'));
        assert.ok(fn.includes('rollbackCredits'), 'a provider failure must refund the debit');
    });

    test('every provider failure passes the credits to refund', () => {
        const calls = [...server.matchAll(/providerFailure\(res,\s*error,\s*'([A-Za-z]+)'([^)]*)\)/g)];
        assert.ok(calls.length > 0, 'no providerFailure call sites found');
        for (const [, engine, rest] of calls) {
            assert.ok(/credits:/.test(rest), `${engine} failure does not refund credits`);
        }
    });

    // A refund amount written as a literal drifts from the charge the moment
    // either is edited.
    test('charge and refund share one constant', () => {
        for (const name of ['FLUX_COST', 'VIDEO_COST']) {
            const defs = [...server.matchAll(new RegExp(`(?:const|let)\\s+${name}\\s*=`, 'g'))];
            assert.strictEqual(defs.length, 1, `${name} is defined ${defs.length} times — the charge and refund can drift`);
        }
        // The refund is what was actually debited: `charged` is set from the
        // shared constant only once the debit succeeds, so an error thrown
        // before the debit refunds nothing instead of minting credits.
        assert.ok(server.includes('charged = FLUX_COST;'), 'Flux must record its charge from the shared constant');
        assert.ok(server.includes('charged = VIDEO_COST;'), 'Video must record its charge from the shared constant');
    });
});
