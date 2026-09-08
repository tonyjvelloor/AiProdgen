const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// The invariant: every generation that can cost the platform produces an
// auditable ai_runs record. Six routes used to spend money and create no run
// row at all, which broke cost coverage, gross margin, and the spend ceiling
// simultaneously.
const MONEY_ROUTES = [
    '/api/generate-image',
    '/api/upscale-esrgan',
    '/api/upscale-esrgan-paid',
    '/api/video/generate',
    '/api/video/generate-veo',
    '/api/image/generate-flux',
    '/api/ugc/render-scene'
];

function bodyOf(route) {
    const start = server.indexOf(`app.post('${route}'`);
    assert.notStrictEqual(start, -1, `route ${route} not found`);
    // Next route definition, or 300 lines, whichever comes first.
    const next = server.indexOf("\napp.", start + 10);
    return server.slice(start, next === -1 ? start + 12000 : next);
}

describe('every money-spending route records usage', () => {
    for (const route of MONEY_ROUTES) {
        test(`${route} creates a run record`, () => {
            assert.ok(bodyOf(route).includes('UsageRecorder.record'),
                `${route} can spend money without producing an ai_runs record`);
        });
    }
});

describe('funding attribution', () => {
    test('Veo generations are recorded as customer-funded', () => {
        for (const route of ['/api/video/generate-veo', '/api/ugc/render-scene']) {
            const body = bodyOf(route);
            const idx = body.indexOf("model: 'veo'");
            assert.notStrictEqual(idx, -1, `${route} has no Veo usage record`);
            assert.ok(body.slice(idx, idx + 120).includes("fundedBy: 'byok'"),
                `${route} records Veo as platform-funded — it is BYOK only`);
        }
    });

    test('Replicate generations are recorded as platform-funded', () => {
        const flux = bodyOf('/api/image/generate-flux');
        const idx = flux.indexOf('UsageRecorder.record');
        assert.ok(flux.slice(idx, idx + 200).includes("fundedBy: 'platform'"),
            'flux runs on the platform key and is COGS');
    });
});

describe('cost prices are centralised', () => {
    const CostEstimator = require('../lib/cost_estimator');

    test('every model a usage record names has a price', () => {
        // Scoped to UsageRecorder.record(...) calls. A bare `model:` elsewhere
        // is a provider API model name (e.g. 'veo-2-generate-001'), not a key
        // in the price table.
        const calls = [...server.matchAll(/UsageRecorder\.record\(\{([\s\S]{0,320}?)\}\)/g)].map((m) => m[1]);
        assert.ok(calls.length >= 7, `expected a record call per money route, found ${calls.length}`);

        const models = new Set();
        for (const call of calls) {
            // `model: 'x'` — but not the comparison operand in a ternary, so
            // the ternary form is matched first and takes precedence.
            const ternary = call.match(/model:[^,}]*\?\s*'([a-z0-9-]+)'\s*:\s*'([a-z0-9-]+)'/);
            if (ternary) {
                models.add(ternary[1]);
                models.add(ternary[2]);
                continue;
            }
            const direct = call.match(/model:\s*'([a-z0-9-]+)'/);
            if (direct) models.add(direct[1]);
        }

        assert.ok(models.size > 0, 'no models found in usage records');
        for (const model of models) {
            assert.notStrictEqual(CostEstimator.priceOf(model), undefined,
                `model "${model}" has no entry in the price table — its cost would record as 0`);
        }
    });

    test('an unknown model records zero rather than throwing', () => {
        const e = CostEstimator.estimateProvider('not-a-real-model', 1);
        assert.strictEqual(e.providerCost, 0);
    });
});

describe('metrics separate funded and unfunded work', () => {
    const metrics = server.slice(server.indexOf("app.get('/api/admin/metrics'"),
                                 server.indexOf("app.get('/api/admin/metrics'") + 7000);

    test('cost coverage is scoped to platform-funded runs', () => {
        assert.ok(metrics.includes('platformRuns'), 'coverage must exclude BYOK runs');
        assert.ok(metrics.includes('funded_by'), 'metrics must read the funding column');
    });

    test('both funding counts are reported', () => {
        assert.ok(metrics.includes('platformFundedRuns') && metrics.includes('customerFundedRuns'));
    });
});
