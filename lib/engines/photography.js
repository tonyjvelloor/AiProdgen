const OutputService = require('../output_service');
const ExecutionCoordinator = require('../execution_coordinator');
const CostEstimator = require('../cost_estimator');
const PolicyEngine = require('../policy_engine');
const { supabaseAdmin } = require('../supabase');

const PACKS = {
    'studio': {
        name: 'Studio Pack',
        description: 'Professional e-commerce on white background',
        shots: [
            { name: 'Hero', promptModifiers: 'Centered hero shot, seamless white background, crisp studio lighting, high contrast.' },
            { name: '45° Angle', promptModifiers: 'Shot from a 45 degree angle, white background, soft shadows.' },
            { name: 'Close-up', promptModifiers: 'Extreme close-up macro shot highlighting material texture and details, white background.' },
            { name: 'Detail', promptModifiers: 'Detailed focus on unique product feature, studio lighting, white background.' }
        ]
    },
    'lifestyle': {
        name: 'Lifestyle Pack',
        description: 'Real-world context and environment',
        shots: [
            { name: 'Environment', promptModifiers: 'Placed in a natural, bright, modern home environment, soft sunlight.' },
            { name: 'In Use', promptModifiers: 'Product being used in a realistic lifestyle scenario, blurred background.' },
            { name: 'Premium Scene', promptModifiers: 'Product resting on a beautiful wooden table with lifestyle props, cinematic lighting.' }
        ]
    },
    'luxury': {
        name: 'Luxury Pack',
        description: 'Premium branding with dark tones',
        shots: [
            { name: 'Dark Premium', promptModifiers: 'Dark moody lighting, black background, rim lighting highlighting edges.' },
            { name: 'Marble', promptModifiers: 'Resting on a premium dark marble slab, elegant shadows.' },
            { name: 'Reflection', promptModifiers: 'Placed on a reflective glass surface, dramatic lighting, luxury feel.' }
        ]
    }
};

class PhotographyEngine {
    /**
     * Get available photography packs.
     */
    static getPacks() {
        return Object.keys(PACKS).map(key => ({
            id: key,
            ...PACKS[key]
        }));
    }

    /**
     * Start a Photography Shoot Job
     * @param {string} userId 
     * @param {string} productId 
     * @param {string} packId 
     * @param {string} aspectRatio 
     * @returns {Promise<Object>} Output Collection
     */
    static async startShoot(userId, productId, packId, aspectRatio = '1:1') {
        const pack = PACKS[packId];
        if (!pack) throw new Error(`Pack ${packId} not found`);

        // 1. Fetch Product Memory
        const { data: product, error } = await supabaseAdmin
            .from('products')
            .select('*')
            .eq('id', productId)
            .single();

        if (error || !product) {
            throw new Error('Product not found for memory extraction');
        }

        // 2. Estimate Costs & Check Policy
        const jobOptions = {
            numImages: pack.shots.length
        };
        const estimatedCosts = CostEstimator.estimateJob('photography', jobOptions);
        
        // Passing null for req here, could be passed from route but userId is enough
        const policyContext = { userId, jobType: 'photography' };
        const policyResult = await PolicyEngine.evaluateRequest(policyContext, estimatedCosts);
        
        if (!policyResult.allowed) {
            const err = new Error(policyResult.reasons.join(', '));
            err.status = 403;
            throw err;
        }

        // 3. Product Memory -> Base Prompt
        const basePrompt = `Product: ${product.name}. Category: ${product.category || 'General'}. Brand: ${product.brand || 'Premium'}. USP: ${product.usp || 'High quality'}.`;

        const snapshot = {
            name: product.name,
            category: product.category,
            brand: product.brand,
            usp: product.usp,
            target_audience: product.target_audience,
            description: product.description,
            price: product.price
        };

        // 4. Create the Output Collection (Job container)
        const collection = await OutputService.createCollection(productId, 'photography', {
            pack_type: packId,
            pack_name: pack.name,
            aspect_ratio: aspectRatio,
            version: 1, 
            base_prompt: basePrompt,
            snapshot: snapshot,
            engine_version: "1.0",
            prompt_version: "1.0"
        });

        // 5. Dispatch to Execution Coordinator (Non-blocking)
        ExecutionCoordinator.processJob(
            { userId, productId, collectionId: collection.id, jobType: 'photography' },
            estimatedCosts,
            pack.shots,
            {
                basePrompt,
                category: product.category,
                packType: packId,
                packVersion: 1,
                aspectRatio,
                inputImageId: product.primary_output_id
            }
        );

        // 4. Return immediately to the client
        return collection;
    }
}

module.exports = PhotographyEngine;
