const db = require('../database');
const { getUserProviderKey } = require('./userKeys');

const MONTHLY_LIMITS = {
    free_explorer: 20, free: 20, hobbyist_ltd: 500, creator: 500,
    pro_founder_ltd: 3000, pro: 3000, agency_ltd: 25000, agency: 25000, lifetime_founder: 25000
};

async function prepareCosts(userId, costs, imageCount) {
    const ownKey = await getUserProviderKey(userId, 'gemini');
    costs.fundedBy = ownKey ? 'byok' : 'platform';
    costs.creditCost = ownKey ? 0 : costs.outputs;
    costs.quotaImages = ownKey ? imageCount : 0;
    if (ownKey) {
        costs.providerCost = 0;
        costs.totalCost = costs.storageCost + costs.platformCost;
    } else if (!process.env.GEMINI_API_KEY) {
        throw Object.assign(new Error('Add your Gemini API key in Settings before generating.'), { status: 403 });
    }
    return costs;
}

async function reserveAllowance(userId, imageCount) {
    if (!imageCount) return null;
    const plan = await db.getUserPlan(userId);
    const reservation = await db.reserveGenerationQuota(userId, imageCount, MONTHLY_LIMITS[plan.plan] || 20);
    if (!reservation) throw new Error('Monthly image allowance reached. Upgrade your plan or wait until next month.');
    return reservation;
}

module.exports = { MONTHLY_LIMITS, prepareCosts, reserveAllowance };
