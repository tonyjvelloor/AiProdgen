const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PLAN_PRICES, CREDIT_PACKAGES, planForOrder } = require('../lib/plans');
const CommerceEngine = require('../lib/engines/commerce');
const PhotographyEngine = require('../lib/engines/photography');

describe('India scale readiness: INR UPI pricing, marketplace packs, timeouts & mobile UX', () => {
    test('all lifetime tiers support native INR checkout with distinct amounts from credit packs', () => {
        assert.equal(planForOrder({ currency: 'INR', amount: 399900 }), 'hobbyist_ltd');
        assert.equal(planForOrder({ currency: 'INR', amount: 799900 }), 'pro_founder_ltd');
        assert.equal(planForOrder({ currency: 'INR', amount: 1499900 }), 'agency_ltd');

        const creditInrAmounts = new Set(Object.values(CREDIT_PACKAGES).map(p => p.amount_inr));
        for (const [planId, prices] of Object.entries(PLAN_PRICES)) {
            assert.ok(prices.onetime_inr > 0, `${planId} must define onetime_inr for UPI checkout`);
            assert.ok(!creditInrAmounts.has(prices.onetime_inr), `${planId} INR price collides with a credit package`);
        }
    });

    test('Indian marketplace launch packs are registered with accurate image and copy counts', () => {
        const packs = CommerceEngine.getPacks();
        const byId = Object.fromEntries(packs.map(p => [p.id, p]));
        for (const id of ['flipkart_amazon_in', 'meesho', 'myntra', 'whatsapp_insta']) {
            assert.ok(byId[id], `missing Indian commerce pack: ${id}`);
            assert.ok(byId[id].imagesCount > 0, `${id} should report imagesCount`);
            assert.ok(byId[id].copyCount > 0, `${id} should report copyCount`);
            assert.equal(byId[id].imagesCount + byId[id].copyCount, byId[id].outputs);
        }
    });

    test('Indian Model and Diwali/Wedding festive photography packs exist', () => {
        const packs = PhotographyEngine.getPacks();
        const ids = new Set(packs.map(p => p.id));
        assert.ok(ids.has('indian_model'), 'missing indian_model photography pack');
        assert.ok(ids.has('festive_india'), 'missing festive_india photography pack');
    });

    test('vercel.json configures maxDuration to prevent serverless multi-shot timeouts', () => {
        const vercelCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
        assert.ok(vercelCfg.functions?.['api/**/*.js']?.maxDuration >= 60, 'maxDuration must be >= 60s');
    });

    test('product.html keeps Generate and View Assets buttons visible on mobile screens', () => {
        const productHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'product.html'), 'utf8');
        assert.ok(!productHtml.includes('<div class="hidden md:block">'), 'job action buttons must not be hidden on mobile');
    });
});
