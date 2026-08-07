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
}

module.exports = CostEstimator;
