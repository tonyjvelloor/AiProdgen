const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// The CEO dashboard reported a hardcoded "$29.00" revenue and "82%" gross
// margin, next to a comment admitting they were mocked. It would therefore
// have shown a healthy margin while the business lost money on every Veo
// generation. These assert the fabricated values do not come back.
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const metrics = server.slice(
    server.indexOf("app.get('/api/admin/metrics'"),
    server.indexOf("app.get('/api/admin/metrics'") + 6000
);

describe('admin metrics report real data', () => {
    for (const literal of ['`$29.00`', '`82%`', 'runs: 124', '`98.2%`', '`3.2m`', '`$0.12`', '`42%`', '`1.8x`', '`14%`', '`64%`', '`48m`']) {
        test(`does not hardcode ${literal}`, () => {
            assert.ok(!metrics.includes(literal), `${literal} is back in /api/admin/metrics`);
        });
    }

    test('computes cost from the ai_runs columns', () => {
        for (const col of ['provider_cost', 'storage_cost', 'platform_cost']) {
            assert.ok(metrics.includes(col), `metrics must read ${col}`);
        }
    });

    test('reads revenue from the payments ledger', () => {
        assert.ok(metrics.includes('db.getRevenue'), 'metrics must read recorded payments');
    });

    test('reports how much AI spend is actually measured', () => {
        assert.ok(metrics.includes('costCoverage'),
            'aiCost is a lower bound until every path records its cost — say so');
    });
});
