const OutputService = require('../output_service');
const JobRunner = require('../job_runner');

const PACKS = {
    'matrix': {
        id: 'matrix',
        title: 'Creative Testing Matrix',
        description: 'Structured testing matrix (Audience, Hook, Offer, Visual, Copy).',
        outputs: 4, // E.g. 4 core concepts
        estimated_time: '120 sec',
        cost: 10,
        shots: [
            { name: 'Concept 1', type: 'creative_matrix', template: 'matrix_concept', promptModifiers: 'Audience: Cold, Hook: Problem Solution, Visual: Lifestyle' },
            { name: 'Concept 2', type: 'creative_matrix', template: 'matrix_concept', promptModifiers: 'Audience: Cold, Hook: Social Proof, Visual: Studio' },
            { name: 'Concept 3', type: 'creative_matrix', template: 'matrix_concept', promptModifiers: 'Audience: Warm, Hook: Transformation, Visual: Editorial' },
            { name: 'Concept 4', type: 'creative_matrix', template: 'matrix_concept', promptModifiers: 'Audience: Retargeting, Hook: Scarcity, Visual: Product Focus' }
        ]
    }
};

class CreativeTestingEngine {
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
     * Start a Creative Testing Production Run.
     */
    static async startRun(userId, productId, packId, productContext, inputImageId) {
        const pack = PACKS[packId];
        if (!pack) throw new Error("Invalid pack ID");

        // 1. Create Collection
        const collection = await OutputService.createCollection(productId, 'creative_testing', {
            pack_id: packId,
            pack_name: pack.title,
            total_outputs: pack.outputs,
            snapshot: productContext, // Snapshotting the product context at runtime
            engine_version: "1.0",
            prompt_version: "1.0"
        });

        // 2. Dispatch Job
        // The JobRunner will see type: 'creative_matrix' and should hit the CopyService for JSON generation.
        // CopyService handles text generation based on the `basePrompt` + `promptModifiers`.
        JobRunner.processJob(userId, productId, collection.id, pack.shots, {
            basePrompt: `Product: ${productContext.brand} ${productContext.category}. ${productContext.usp}. Target Audience: ${productContext.target_audience}. Generate a JSON object for a creative ad matrix. Fields: Hypothesis, Audience, Hook, Offer, VisualConcept, Headline, PrimaryText, CTA, Rationale.`,
            inputImageId: inputImageId,
            packType: packId,
            packVersion: 1.0,
            productContext: productContext
        });

        return collection;
    }
}

module.exports = CreativeTestingEngine;
