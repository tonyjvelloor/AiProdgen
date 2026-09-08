// Provider unit costs in USD. These are the platform's COGS and the input to
// both margin reporting and the spend ceiling, so they belong in one place
// rather than scattered across routes.
//
// Verify against current provider pricing when it changes -- Replicate and
// Google both move. The relative magnitudes are what matter most: Veo is on a
// different order from everything else, which is why it is BYOK-only.
const PROVIDER_PRICES = {
    'flux-schnell':   0.003,   // black-forest-labs/flux-schnell, per image
    'flux-dev':       0.030,
    'esrgan':         0.005,   // real-esrgan upscale, per image
    'instant-id':     0.010,   // zsxkib/instant-id, per image
    'ltx-video':      0.080,   // lightricks/ltx-2-fast, per short clip
    'wan-i2v':        0.120,
    'gemini-image':   0.039,   // gemini-2.5-flash-image, per image
    'gemini-text':    0.010,   // per copy generation
    'veo':            2.000    // veo-2, per clip -- BYOK only, never platform-funded
};

const STORAGE_PER_OUTPUT = 0.001;
const PLATFORM_PER_REQUEST = 0.005;

class CostEstimator {
    /**
     * Estimates outputs and financial cost for an AI job before execution.
     * 
     * @param {string} jobType - 'photography', 'campaign', 'blueprint', 'copy', etc.
     * @param {Object} options - Details like number of concepts, images, etc.
     * @returns {Object} { outputs, providerCost, storageCost, platformCost, totalCost }
     */
    static estimateJob(jobType, options = {}) {
        let outputs = 0;
        let providerCost = 0;
        let storageCost = 0.0001; // Base per output
        let platformCost = 0.005; // Base per request

        switch (jobType) {
            case 'photography':
            case 'generate-image':
                outputs = options.numImages || 1;
                providerCost = outputs * 0.03; // Flux Dev is 0.03
                storageCost = outputs * 0.001;
                break;
            case 'upscale-esrgan':
                outputs = 1;
                providerCost = 0.05; // Base replicate ESRGAN cost
                storageCost = 0.002;
                break;
            case 'blueprint':
            case 'generate-text':
            case 'copy':
                outputs = 0; // Text is free or negligible output credits for now
                providerCost = 0.01; // Gemini Pro API approx cost
                storageCost = 0; 
                break;
            case 'campaign_production':
                // Options should have numConcepts. 1 image + 1 copy per concept.
                const concepts = options.numConcepts || 1;
                outputs = concepts; // 1 image = 1 output credit
                providerCost = (concepts * 0.03) + (concepts * 0.01); // Flux + Gemini
                storageCost = concepts * 0.001;
                break;
            default:
                outputs = 1;
                providerCost = 0.03;
                break;
        }

        return {
            outputs,
            providerCost,
            storageCost,
            platformCost,
            totalCost: providerCost + storageCost + platformCost
        };
    }
    /**
     * Cost of a single provider call, for routes that know their model.
     * @param {string} model - key in PROVIDER_PRICES
     * @param {number} count - number of outputs
     */
    static estimateProvider(model, count = 1) {
        const unit = PROVIDER_PRICES[model];
        if (unit === undefined) {
            console.warn(`[cost] no price for model "${model}" — recording 0, margin will be overstated`);
        }
        const providerCost = (unit || 0) * count;
        const storageCost = STORAGE_PER_OUTPUT * count;
        return {
            outputs: count,
            providerCost,
            storageCost,
            platformCost: PLATFORM_PER_REQUEST,
            totalCost: providerCost + storageCost + PLATFORM_PER_REQUEST
        };
    }

    static priceOf(model) {
        return PROVIDER_PRICES[model];
    }
}

module.exports = CostEstimator;
module.exports.PROVIDER_PRICES = PROVIDER_PRICES;

