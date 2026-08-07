const OutputService = require('../output_service');
const ExecutionCoordinator = require('../execution_coordinator');
const CostEstimator = require('../cost_estimator');
const PolicyEngine = require('../policy_engine');
const PACKS = {
    'campaign': {
        id: 'campaign',
        title: 'Campaign Blueprint',
        description: 'Strategic campaign hypotheses (Audience, Hook, Offer, Expected Outcome).',
        outputs: 4, 
        estimated_time: '120 sec',
        cost: 10,
        shots: [
            { name: 'Concept 1', type: 'blueprint', template: 'matrix_concept', promptModifiers: 'Audience: Cold, Hook: Problem Solution, Visual: Lifestyle' },
            { name: 'Concept 2', type: 'blueprint', template: 'matrix_concept', promptModifiers: 'Audience: Cold, Hook: Social Proof, Visual: Studio' },
            { name: 'Concept 3', type: 'blueprint', template: 'matrix_concept', promptModifiers: 'Audience: Warm, Hook: Transformation, Visual: Editorial' },
            { name: 'Concept 4', type: 'blueprint', template: 'matrix_concept', promptModifiers: 'Audience: Retargeting, Hook: Scarcity, Visual: Product Focus' }
        ]
    }
};

class BlueprintEngine {
    static getPacks() {
        return Object.values(PACKS).map(p => ({
            id: p.id,
            title: p.title,
            description: p.description,
            outputs: p.outputs,
            estimated_time: p.estimated_time,
            cost: p.cost
        }));
    }

    /**
     * Start a Campaign Blueprint Run.
     */
    static async startRun(userId, productId, packId, productContext, inputImageId) {
        const pack = PACKS[packId];
        if (!pack) throw new Error("Invalid pack ID");

        // 1. Estimate Costs & Check Policy
        let numCopy = pack.shots.length; // Blueprint just generates JSON text
        const estimatedCosts = CostEstimator.estimateJob('blueprint', { numImages: 0, numCopy });
        // Manually override
        estimatedCosts.outputs = 0; // Let's say text costs 0 output credits, or maybe we want to charge? The user said "Text is free or negligible output credits for now".
        estimatedCosts.providerCost = numCopy * 0.01;
        estimatedCosts.storageCost = 0;
        estimatedCosts.totalCost = estimatedCosts.providerCost + estimatedCosts.storageCost + estimatedCosts.platformCost;

        const policyContext = { userId, jobType: 'blueprint' };
        const policyResult = await PolicyEngine.evaluateRequest(policyContext, estimatedCosts);
        
        if (!policyResult.allowed) {
            const err = new Error(policyResult.reasons.join(', '));
            err.status = 403;
            throw err;
        }

        // 2. Create Collection
        const collection = await OutputService.createCollection(productId, 'campaign_blueprint', {
            pack_id: packId,
            pack_name: pack.title,
            total_outputs: pack.outputs,
            snapshot: productContext,
            engine_version: "2.0",
            prompt_version: "2.0"
        });

        // 3. Dispatch Job
        ExecutionCoordinator.processJob(
            { userId, productId, collectionId: collection.id, jobType: 'blueprint' },
            estimatedCosts,
            pack.shots,
            {
                basePrompt: `Product: ${productContext.brand} ${productContext.category}. ${productContext.usp}. Target Audience: ${productContext.target_audience}. Generate a JSON object for a campaign hypothesis. Exact Fields Required: Name, Hypothesis, Audience, Hook, Offer, ExpectedOutcome, WhyItShouldWork, WhenToUse, VisualDirection, Headline, PrimaryText, CTA.`,
                inputImageId: inputImageId,
                packType: packId,
                packVersion: 2.0,
                productContext: productContext
            }
        );

        return collection;
    }
}

module.exports = BlueprintEngine;
