const OutputService = require('../output_service');
const ExecutionCoordinator = require('../execution_coordinator');
const CostEstimator = require('../cost_estimator');
const PolicyEngine = require('../policy_engine');
const PACKS = {
    'amazon': {
        id: 'amazon',
        title: 'Amazon Launch Pack',
        description: 'Complete visual and copy pack tailored for Amazon listing conversion.',
        outputs: 8,
        estimated_time: '120 sec',
        cost: 8,
        shots: [
            { name: 'Hero', type: 'image', template: 'amazon_hero', promptModifiers: 'Clean bright studio lighting, pure white background, centered composition, high resolution, soft shadows' },
            { name: 'White Background', type: 'image', template: 'amazon_white', promptModifiers: 'Product isolated on absolute white background, commercial lighting, high contrast, e-commerce ready' },
            { name: 'Lifestyle', type: 'image', template: 'amazon_lifestyle', promptModifiers: 'In use in a natural environment, highly engaging, relatable context, professional lifestyle photography' },
            { name: 'Feature Layout', type: 'image', template: 'amazon_feature', promptModifiers: 'Product placed with generous negative space around it for text overlays, clean minimal background, clear focus on details' },
            { name: 'Dimension Layout', type: 'image', template: 'amazon_dimension', promptModifiers: 'Flat straight-on angle, technical lighting, grid-like negative space for measurement lines, clean background' },
            { name: 'Product Title', type: 'copy', template: 'amazon_title', promptModifiers: 'Write a highly optimized Amazon product title (max 200 chars). Include brand name, key features, material, and target keyword.' },
            { name: 'Bullet Points', type: 'copy', template: 'amazon_bullets', promptModifiers: 'Write 5 compelling Amazon bullet points. Focus on benefits, features, specifications, and warranty. Keep each under 200 characters.' },
            { name: 'Description', type: 'copy', template: 'amazon_description', promptModifiers: 'Write a persuasive Amazon product description. Tell a story about the product, explain how it solves the customers problem, and include a strong call to action.' }
        ]
    },
    'shopify': {
        id: 'shopify',
        title: 'Shopify Launch Pack',
        description: 'Page-ready content and visuals for a high-converting Shopify store.',
        outputs: 7,
        estimated_time: '90 sec',
        cost: 7,
        shots: [
            { name: 'Hero', type: 'image', template: 'shopify_hero', promptModifiers: 'Premium brand aesthetic, moody or bright depending on brand, high-end commercial photography, subtle props' },
            { name: 'Description', type: 'copy', template: 'shopify_description', promptModifiers: 'Write a long-form premium Shopify product description. Focus on brand storytelling, emotional connection, and high-end lifestyle appeal.' },
            { name: 'Benefits', type: 'copy', template: 'shopify_benefits', promptModifiers: 'Write 3 short, punchy benefit statements for a Shopify icon grid. Focus on the transformation the product provides.' },
            { name: 'Features', type: 'copy', template: 'shopify_features', promptModifiers: 'Write a detailed technical features list for a Shopify accordion section.' },
            { name: 'Trust Section', type: 'copy', template: 'shopify_trust', promptModifiers: 'Write a short trust-building section covering shipping, returns, and satisfaction guarantee.' },
            { name: 'SEO Title', type: 'copy', template: 'shopify_seo_title', promptModifiers: 'Write an SEO-optimized page title for Shopify (max 60 chars).' },
            { name: 'SEO Description', type: 'copy', template: 'shopify_seo_desc', promptModifiers: 'Write an SEO-optimized meta description for Shopify (max 160 chars).' }
        ]
    }
};

class CommerceEngine {
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
     * Start a Commerce Production Run.
     */
    static async startRun(userId, productId, packId, productContext, inputImageId) {
        const pack = PACKS[packId];
        if (!pack) throw new Error("Invalid pack ID");

        // 1. Estimate Costs & Check Policy
        let numImages = 0;
        let numCopy = 0;
        pack.shots.forEach(s => {
            if (s.type === 'image') numImages++;
            else numCopy++;
        });

        // The estimator for commerce hasn't been explicitly defined, we'll map to custom calculation or 'campaign_production' equivalent logic.
        // Let's pass the raw options to estimator.
        const estimatedCosts = CostEstimator.estimateJob('commerce', { numImages, numCopy });
        // Manually override if CostEstimator doesn't support 'commerce' natively yet:
        estimatedCosts.outputs = numImages + numCopy; // Assume 1 credit per output for simplicity
        estimatedCosts.providerCost = (numImages * 0.03) + (numCopy * 0.01);
        estimatedCosts.storageCost = (numImages * 0.001);
        estimatedCosts.totalCost = estimatedCosts.providerCost + estimatedCosts.storageCost + estimatedCosts.platformCost;

        const policyContext = { userId, jobType: 'commerce' };
        const policyResult = await PolicyEngine.evaluateRequest(policyContext, estimatedCosts);
        
        if (!policyResult.allowed) {
            const err = new Error(policyResult.reasons.join(', '));
            err.status = 403;
            throw err;
        }

        // 2. Create Collection
        const collection = await OutputService.createCollection(productId, 'commerce', {
            pack_id: packId,
            pack_name: pack.title,
            total_outputs: pack.outputs,
            snapshot: productContext, 
            engine_version: "1.0",
            prompt_version: "1.0"
        });

        // 3. Dispatch Job
        ExecutionCoordinator.processJob(
            { userId, productId, collectionId: collection.id, jobType: 'commerce' },
            estimatedCosts,
            pack.shots,
            {
                basePrompt: `Product: ${productContext.brand} ${productContext.category}. ${productContext.usp}.`,
                inputImageId: inputImageId,
                packType: packId,
                packVersion: 1.0,
                productContext: productContext 
            }
        );

        return collection;
    }
}

module.exports = CommerceEngine;
