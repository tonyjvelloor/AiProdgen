// lib/plans.js
// Centralized definitions for plans, pricing tiers, and credit packages.

const CREDIT_PACKAGES = {
    starter: { credits: 50, amount_inr: 39900, amount_usd: 500, name: 'Starter Monthly' },
    value: { credits: 150, amount_inr: 99900, amount_usd: 1200, name: 'Starter Yearly (Deal)' },
    pro: { credits: 200, amount_inr: 149900, amount_usd: 2000, name: 'Pro Creator' },
    agency: { credits: 1000, amount_inr: 499900, amount_usd: 6000, name: 'Agency Power' }
};

const PLANS = {
    free_explorer: { gen_limit: 0, byok_gen_limit: 20, upscale: 0, ugc: 0, director: false, veo: false, requires_byok: true, watermark: true, templates: 'none', bulk: false, commercial: false },
    hobbyist_ltd: { gen_limit: 0, byok_gen_limit: 500, upscale: 0, ugc: 0, director: false, veo: false, requires_byok: true, watermark: false, templates: 'basic', bulk: false, commercial: true },
    pro_founder_ltd: { gen_limit: 0, byok_gen_limit: 3000, upscale: 50, ugc: 10, director: true, veo: true, requires_byok: true, watermark: false, templates: 'advanced', bulk: false, commercial: true },
    agency_ltd: { gen_limit: 0, byok_gen_limit: 25000, upscale: 120, ugc: 50, director: true, veo: true, requires_byok: true, watermark: false, templates: 'advanced', bulk: true, commercial: true, agency_license: true, priority: true },
    lifetime_founder: { gen_limit: 0, byok_gen_limit: 25000, upscale: 999, ugc: 50, director: true, veo: true, requires_byok: true, watermark: false, templates: 'advanced', bulk: true, commercial: true }
};

const PLAN_ALIASES = {
    free: 'free_explorer',
    creator: 'hobbyist_ltd',
    pro: 'pro_founder_ltd',
    agency: 'agency_ltd'
};

const PLAN_PRICES = {
    hobbyist_ltd: { onetime_usd: 4700 },  // $47
    pro_founder_ltd: { onetime_usd: 9700 },  // $97
    agency_ltd: { onetime_usd: 19700 }   // $197
};

const PLAN_TIER_RANK = {
    free_explorer: 0,
    free: 0,
    hobbyist_ltd: 1,
    creator: 1,
    pro_founder_ltd: 2,
    pro: 2,
    agency_ltd: 3,
    agency: 3,
    lifetime_founder: 4
};

function shouldUpgradePlan(currentPlan, targetPlan) {
    if (!targetPlan) return false;
    if (!currentPlan) return true;
    const currentRank = PLAN_TIER_RANK[PLAN_ALIASES[currentPlan] || currentPlan] || 0;
    const targetRank = PLAN_TIER_RANK[PLAN_ALIASES[targetPlan] || targetPlan] || 0;
    return targetRank >= currentRank;
}

const LIFETIME_OFFER_PRICES = {
    USD: [47],
    INR: [3999]
};

function getPlanConfig(planName) {
    const resolved = PLAN_ALIASES[planName] || planName;
    return PLANS[resolved] || PLANS.free_explorer;
}

function planForOrder(order) {
    if (!order) return null;
    if (order.currency === 'INR' && Number(order.amount) === 399900) return 'hobbyist_ltd';
    if (order.currency !== 'USD') return null;
    const amount = Number(order.amount);
    if (amount === 4900) return 'hobbyist_ltd'; // Already-issued legacy order.
    return Object.keys(PLAN_PRICES).find(id => PLAN_PRICES[id].onetime_usd === amount) || null;
}

function creditPackageForOrder(order) {
    const field = order && ({ USD: 'amount_usd', INR: 'amount_inr' })[order.currency];
    if (!field) return null;
    const amount = Number(order.amount);
    return Object.keys(CREDIT_PACKAGES).find(id => CREDIT_PACKAGES[id][field] === amount) || null;
}

function isLifetimeOfferOrder(order) {
    if (!order) return false;
    const amount = Number(order.amount);
    return (LIFETIME_OFFER_PRICES[order.currency] || []).some(p => Math.round(p * 100) === amount);
}

module.exports = {
    CREDIT_PACKAGES,
    PLANS,
    PLAN_ALIASES,
    PLAN_PRICES,
    PLAN_TIER_RANK,
    shouldUpgradePlan,
    LIFETIME_OFFER_PRICES,
    getPlanConfig,
    planForOrder,
    creditPackageForOrder,
    isLifetimeOfferOrder
};
