// lib/usage_recorder.js
//
// One call, one auditable ai_runs record.
//
// The V2 engines record cost through ExecutionCoordinator, but six legacy
// routes spend real money and created no run row at all. That left three
// things broken at once: cost coverage could not be measured, gross margin was
// a lower bound of unknown tightness, and the PolicyEngine spend ceiling could
// not see the spend it was meant to cap.
//
// The invariant this exists to hold: every generation that can cost the
// platform produces a run record, tagged with who funded it.
const db = require('../database');
const CostEstimator = require('./cost_estimator');

/**
 * Record one provider call.
 *
 * @param {string}  userId
 * @param {string}  job        engine/route name, e.g. 'flux_image', 'upscale'
 * @param {string}  model      key in CostEstimator's price table
 * @param {string}  fundedBy   'platform' (COGS) or 'byok' (customer's key)
 * @param {number}  outputs    number of generations
 * @param {string}  status     'completed' | 'failed'
 * @param {string}  [error]
 * @param {string}  [productId]
 * @returns {Promise<string|null>} run id
 */
async function record({ userId, job, model, fundedBy = 'platform', outputs = 1, status = 'completed', error = null, productId = null }) {
    if (!userId) return null;

    // A customer-funded run costs the platform nothing, but it is still
    // recorded: it is the difference between "free because BYOK" and "cost
    // unknown because nobody wrote it down".
    const estimate = fundedBy === 'byok'
        ? { providerCost: 0, storageCost: 0, platformCost: 0, totalCost: 0 }
        : CostEstimator.estimateProvider(model, outputs);

    try {
        const runId = await db.createAIRun(userId, productId, null, job, estimate.totalCost, outputs);
        if (!runId) return null;

        await db.updateAIRun(runId, {
            status,
            funded_by: fundedBy,
            outputs_used: status === 'completed' ? outputs : 0,
            provider_cost: estimate.providerCost,
            storage_cost: estimate.storageCost,
            platform_cost: estimate.platformCost,
            completed_at: new Date().toISOString(),
            ...(error ? { error: String(error).slice(0, 500) } : {})
        });

        return runId;
    } catch (e) {
        // Never let accounting break a generation the user already paid for.
        console.error(`[usage] failed to record ${job}:`, e.message);
        return null;
    }
}

module.exports = { record };
