const OutputService = require('../output_service');
const ProductService = require('../product_service');
const ExecutionCoordinator = require('../execution_coordinator');
const CostEstimator = require('../cost_estimator');
const PolicyEngine = require('../policy_engine');

class ProductionEngine {
    /**
     * Start a Campaign Production Run based on selected Blueprint concepts.
     */
    static async startRun(userId, productId, blueprintId, conceptIdsString, productContext) {
        // 1. Fetch Blueprint
        const blueprint = await OutputService.getCollection(blueprintId);
        if (!blueprint) throw new Error("Blueprint not found");

        const conceptIds = conceptIdsString.split(',').map(s => s.trim());
        const selectedConcepts = blueprint.outputs.filter(o => conceptIds.includes(o.id.toString()) && o.type === 'blueprint_json');

        if (selectedConcepts.length === 0) {
            throw new Error("No valid concepts selected");
        }

        // 2. Fetch Product to get primary image
        const product = await ProductService.getProductById(productId);
        const inputImageId = product.primary_output_id;

        // 3. Create a new Collection for Production
        const collection = await OutputService.createCollection(productId, 'campaign_production', {
            blueprint_id: blueprintId,
            total_concepts: selectedConcepts.length,
            total_outputs: selectedConcepts.length * 2, // 1 image + 1 copy per concept
            snapshot: productContext,
            engine_version: "2.0"
        });

        // 4. Build shots from concepts
        const shots = [];
        
        selectedConcepts.forEach((concept, index) => {
            let p = {};
            try {
                const rawJson = concept.metadata && concept.metadata.content ? concept.metadata.content : '{}';
                const cleanedJson = rawJson.replace(/```json/g, '').replace(/```/g, '').trim();
                p = JSON.parse(cleanedJson);
            } catch (e) {
                console.error("Failed to parse concept JSON for production:", e);
                p = { Name: `Concept ${index + 1}` };
            }

            const conceptName = p.Name || `Concept ${index + 1}`;
            
            // Image shot
            shots.push({
                name: `${conceptName} - Visual`,
                type: 'image',
                template: 'campaign_visual',
                promptModifiers: p.VisualDirection ? p.VisualDirection : 'High quality commercial lifestyle photography'
            });

            // Copy shot
            shots.push({
                name: `${conceptName} - Copy`,
                type: 'copy',
                template: 'campaign_copy',
                promptModifiers: `Format this as an Ad Copy block. Headline: ${p.Headline}. Body: ${p.PrimaryText}. CTA: ${p.CTA}. Audience: ${p.Audience}.`
            });
        });

        // 5. Estimate Costs & Check Policy
        const estimatedCosts = CostEstimator.estimateJob('campaign_production', { numConcepts: selectedConcepts.length });
        
        const policyContext = { userId, jobType: 'campaign_production' };
        const policyResult = await PolicyEngine.evaluateRequest(policyContext, estimatedCosts);
        
        if (!policyResult.allowed) {
            const err = new Error(policyResult.reasons.join(', '));
            err.status = 403;
            throw err;
        }

        // 6. Dispatch Job
        ExecutionCoordinator.processJob(
            { userId, productId, collectionId: collection.id, jobType: 'campaign_production' },
            estimatedCosts,
            shots,
            {
                basePrompt: `Product: ${productContext.brand} ${productContext.category}. ${productContext.usp}.`,
                inputImageId: inputImageId,
                packType: 'campaign_production',
                packVersion: 2.0,
                productContext: productContext
            }
        );

        return collection;
    }
}

module.exports = ProductionEngine;
