const { prepareCosts } = require('../generation_billing');
const { runBackground } = require('../background');
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
    },
    'flipkart_amazon_in': {
        id: 'flipkart_amazon_in',
        title: 'Flipkart & Amazon.in A+ Pack',
        description: 'Pure RGB(255,255,255) 85%-fill catalog visuals, infographic zones, and India-optimized SEO copy.',
        outputs: 8,
        estimated_time: '45 sec',
        cost: 8,
        shots: [
            { name: 'Main Hero (Pure White)', type: 'image', template: 'in_hero', aspectRatio: '1:1', promptModifiers: 'Pure RGB(255,255,255) seamless white background, product filling 85% of frame, crisp commercial studio lighting, soft grounded shadow, Flipkart & Amazon.in compliant.' },
            { name: '45° Catalog Angle', type: 'image', template: 'in_angle', aspectRatio: '1:1', promptModifiers: 'Pure white seamless studio background, clean 45-degree product angle highlighting build quality and finish.' },
            { name: 'Indian Home Lifestyle', type: 'image', template: 'in_lifestyle', aspectRatio: '1:1', promptModifiers: 'Product styled naturally in a bright contemporary Indian home or lifestyle setting, warm natural sunlight, authentic commercial photography.' },
            { name: 'Infographic Layout', type: 'image', template: 'in_infographic', aspectRatio: '1:1', promptModifiers: 'Product positioned cleanly on the left side with generous soft neutral negative space on the right for Flipkart/Amazon feature callout badges and icons.' },
            { name: 'Dimension & Detail Shot', type: 'image', template: 'in_dimension', aspectRatio: '1:1', promptModifiers: 'Straight-on technical product view on clean off-white studio surface with even lighting and clear margins for size/dimension overlays.' },
            { name: 'Flipkart/Amazon.in Title', type: 'copy', template: 'in_title', promptModifiers: 'Write an SEO-optimized Amazon.in & Flipkart product title (max 180 chars) targeting Indian shoppers with brand, material, pack size, and primary Hindi/English search terms.' },
            { name: '5 Conversion Bullet Points', type: 'copy', template: 'in_bullets', promptModifiers: 'Write 5 high-converting Amazon.in & Flipkart bullet points tailored for Indian buyers (value-for-money, durability, easy care, ideal gifting/daily use, quality assurance).' },
            { name: 'Backend Search Keywords', type: 'copy', template: 'in_keywords', promptModifiers: 'Generate 20 high-intent Indian marketplace search keywords (including common Hinglish terms) separated by commas for Flipkart and Amazon.in Seller Central.' }
        ]
    },
    'meesho': {
        id: 'meesho',
        title: 'Meesho Catalog & CTR Pack',
        description: 'High-CTR borderless thumbnails, fabric/build close-ups, and Meesho-ready English + Hinglish copy.',
        outputs: 6,
        estimated_time: '35 sec',
        cost: 6,
        shots: [
            { name: 'Meesho Main Thumbnail', type: 'image', template: 'meesho_hero', aspectRatio: '1:1', promptModifiers: 'High-CTR borderless e-commerce product shot, bright inviting studio lighting, clean light neutral backdrop, centered product filling 85% of frame.' },
            { name: 'Close-Up Material Detail', type: 'image', template: 'meesho_detail', aspectRatio: '1:1', promptModifiers: 'Macro close-up highlighting authentic fabric weave, stitching, or build finish under bright clean lighting to build buyer trust.' },
            { name: 'Value / Pack Showcase', type: 'image', template: 'meesho_value', aspectRatio: '1:1', promptModifiers: 'Clean studio display emphasizing everyday practicality, neat presentation, bright commercial lighting, subtle soft shadow.' },
            { name: 'Lifestyle Context', type: 'image', template: 'meesho_lifestyle', aspectRatio: '1:1', promptModifiers: 'Relatable everyday Indian lifestyle setting showing real-world scale and usage, crisp daylight photography.' },
            { name: 'Meesho Catalog Title & Specs', type: 'copy', template: 'meesho_copy', promptModifiers: 'Write a clear, high-CTR Meesho catalog title, short bullet specs (material, size, ideal for, dispatch/care), and value proposition tailored for tier-2 and tier-3 Indian buyers.' },
            { name: 'Reseller WhatsApp Pitch', type: 'copy', template: 'meesho_reseller', promptModifiers: 'Write a crisp, ready-to-forward Hinglish + English WhatsApp reseller product message with emojis, key highlights, and COD/order CTA.' }
        ]
    },
    'myntra': {
        id: 'myntra',
        title: 'Myntra & Ajio 3:4 Fashion Pack',
        description: 'Vertical 3:4 lookbook shots on Myntra-compliant #F4F4F4 studio grey backdrops + fashion listing copy.',
        outputs: 5,
        estimated_time: '35 sec',
        cost: 5,
        shots: [
            { name: '3:4 Studio Grey Hero', type: 'image', template: 'myntra_hero', aspectRatio: '3:4', promptModifiers: 'Vertical 3:4 editorial fashion catalog photography on seamless soft light grey (#F4F4F4) studio backdrop, diffused studio lighting, crisp silhouette, Myntra & Ajio compliant.' },
            { name: 'Indian Model Lookbook', type: 'image', template: 'myntra_model', aspectRatio: '3:4', promptModifiers: 'Vertical 3:4 full-frame commercial lookbook styling featuring an Indian fashion model in a minimal soft-lit studio (#F4F4F4 background), natural pose showcasing exact garment/accessory details.' },
            { name: 'Texture & Craftsmanship Macro', type: 'image', template: 'myntra_detail', aspectRatio: '3:4', promptModifiers: 'Vertical 3:4 macro editorial detail shot emphasizing embroidery, stitching, fabric drape, or metallic polish with soft gallery lighting.' },
            { name: 'Editorial Lifestyle', type: 'image', template: 'myntra_editorial', aspectRatio: '3:4', promptModifiers: 'Vertical 3:4 sunlit modern Indian boutique architectural setting, soft natural shadows, premium D2C fashion campaign aesthetic.' },
            { name: 'Fashion Listing & Styling Note', type: 'copy', template: 'myntra_copy', promptModifiers: 'Write a Myntra/Ajio style product description including Product Details, Size & Fit, Material & Care, and a "Style Note" on how to pair it for festive or everyday Indian wear.' }
        ]
    },
    'whatsapp_insta': {
        id: 'whatsapp_insta',
        title: 'WhatsApp Business & Instagram Reel Kit',
        description: '1:1 WhatsApp catalog hero, 9:16 Story/Reel cards, and ready-to-send Hinglish + English broadcast copy.',
        outputs: 5,
        estimated_time: '30 sec',
        cost: 5,
        shots: [
            { name: 'WhatsApp Catalog 1:1', type: 'image', template: 'wa_catalog', aspectRatio: '1:1', promptModifiers: 'Vibrant, scroll-stopping 1:1 product photograph on a clean premium surface, crisp daylight, high contrast for mobile WhatsApp Business catalog thumbnails.' },
            { name: 'Instagram Story 9:16', type: 'image', template: 'ig_story', aspectRatio: '9:16', promptModifiers: 'Vertical 9:16 mobile-first commercial product visual with product centered in lower-middle third and clean breathing space at the top for price/offer stickers.' },
            { name: 'Festive Aesthetic Lifestyle', type: 'image', template: 'wa_festive', aspectRatio: '1:1', promptModifiers: 'Warm celebratory Indian aesthetic with subtle soft bokeh, brass/marigold accents, luxury boutique photography, focus strictly on the product.' },
            { name: 'WhatsApp Broadcast (Hinglish + EN)', type: 'copy', template: 'wa_broadcast', promptModifiers: 'Write 2 short, high-converting WhatsApp Business broadcast sales messages (1 in crisp English, 1 in natural Hinglish) with emojis, COD/pan-India shipping line, and "Reply ORDER to book" CTA.' },
            { name: 'Instagram Reel Script & Caption', type: 'copy', template: 'ig_reel', promptModifiers: 'Write a 15-second Instagram Reel visual hook script + scroll-stopping caption with 12 targeted Indian e-commerce hashtags.' }
        ]
    }
};

class CommerceEngine {
    static getPacks() {
        return Object.values(PACKS).map(p => {
            const imagesCount = p.shots.filter(s => s.type === 'image').length;
            const copyCount = p.shots.filter(s => s.type !== 'image').length;
            return {
                id: p.id,
                title: p.title,
                description: p.description,
                outputs: p.outputs,
                imagesCount,
                copyCount,
                estimated_time: p.estimated_time,
                cost: p.cost
            };
        });
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
        estimatedCosts.providerCost = (numImages * CostEstimator.priceOf('gemini-image')) + (numCopy * 0.01);
        estimatedCosts.storageCost = (numImages * 0.001);
        estimatedCosts.totalCost = estimatedCosts.providerCost + estimatedCosts.storageCost + estimatedCosts.platformCost;

        await prepareCosts(userId, estimatedCosts, numImages);
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
        runBackground(ExecutionCoordinator.processJob(
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
        ));

        return collection;
    }
}

module.exports = CommerceEngine;
