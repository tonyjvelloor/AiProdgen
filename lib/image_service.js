// lib/image_service.js

const db = require('../database');
const { GoogleGenAI } = require('@google/genai');
const { GEMINI_IMAGE_MODEL } = require('./models');
const { getUserProviderKey } = require('./userKeys');
const CostEstimator = require('./cost_estimator');
const { supabaseAdmin } = require('./supabase');

/**
 * ImageService
 * Edits a stored product reference with Gemini and persists the result.
 */
class ImageService {
    /**
     * @param {string} userId
     * @param {string} inputImageId (Optional) - Supabase storage ID
     * @param {Object} options
     */
    static async generate(userId, inputImageId, options) {
        const startTime = Date.now();
        const { goal, category, style, aspectRatio, presetVersion } = options;
        
        try {
            // 1. Log attempt
            const logId = await db.logGeneration(
                userId, 'gemini', GEMINI_IMAGE_MODEL, 0, 0, 0, 0, 0, 'started', null,
                presetVersion, category, aspectRatio, goal, inputImageId, null, null,
                options.ai_run_id, 0, "1.0", options.collectionId, options.productId
            );

            // 2. Check user plan for watermark/resolution limits
            const userPlan = await db.getUserPlan(userId);
            const isFreeTier = userPlan.plan === 'free_explorer';
            
            // Replicate Flux Dev Base Input
            let width = 1024;
            let height = 1024;
            
            if (aspectRatio === '4:5') { width = 832; height = 1024; }
            if (aspectRatio === '16:9') { width = 1024; height = 576; }
            
            // Free Tier Restrictions: Lower resolution & Watermark
            let watermarkPrompt = "";
            if (isFreeTier) {
                width = Math.floor(width / 1.5);
                height = Math.floor(height / 1.5);
                watermarkPrompt = " Prominent 'AIProdGen Free' watermark in the corner.";
            }

            // Construct Prompt based on Goal, Category, and Style
            const prompt = `Professional product photography of a ${category}. Goal: ${goal}. Style: ${style}.${watermarkPrompt} High quality, 8k resolution, studio lighting.`;
            
            console.log(`[ImageService] Preparing a product-reference edit for user ${userId}. Prompt: ${prompt}`);
            
            // Resolve an image belonging to this product, then fetch only our
            // own storage origin. A caller-controlled URL is never fetched.
            if (!inputImageId || !options.productId) throw new Error('Upload a product image before starting a shoot.');
            const { data: reference, error: referenceError } = await supabaseAdmin.from('outputs')
                .select('storage_path').eq('id', inputImageId).eq('product_id', options.productId).eq('type', 'image').maybeSingle();
            if (referenceError || !reference?.storage_path) throw new Error('Product reference image not found.');
            const source = new URL(reference.storage_path);
            const storage = new URL(process.env.SUPABASE_URL);
            if (source.origin !== storage.origin || !source.pathname.startsWith('/storage/v1/object/public/')) {
                throw new Error('Invalid product image storage location.');
            }
            const imageRes = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(30000) });
            if (!imageRes.ok) throw new Error('Could not load the uploaded product image.');
            const mimeType = imageRes.headers.get('content-type')?.split(';')[0];
            if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new Error('Unsupported reference image format.');
            const referenceBytes = Buffer.from(await imageRes.arrayBuffer());
            if (referenceBytes.length > 20 * 1024 * 1024) throw new Error('Reference image is too large.');
            const ownKey = await getUserProviderKey(userId, 'gemini');
            const apiKey = ownKey || process.env.GEMINI_API_KEY;
            if (!apiKey) throw new Error('Add a Gemini API key in Settings before starting a shoot.');
            const ai = new GoogleGenAI({ apiKey });
            const response = await ai.models.generateContent({
                model: GEMINI_IMAGE_MODEL,
                contents: [
                    { text: `Edit the attached product photo. Preserve the product identity, shape, colors and readable labels as closely as possible. Change the setting and lighting according to this brief: ${prompt}` },
                    { inlineData: { mimeType, data: referenceBytes.toString('base64') } }
                ],
                config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspectRatio || '1:1' } }
            });
            const imagePart = response.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data && !part.thought);
            if (!imagePart) throw new Error('The image provider did not return a finished image.');
            const outputMime = imagePart.inlineData.mimeType || 'image/png';
            const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');

            // 5. Upload to Supabase Storage
            const filename = `${userId}/${require('crypto').randomUUID()}.${outputMime === 'image/jpeg' ? 'jpg' : outputMime === 'image/webp' ? 'webp' : 'png'}`;
            const { data: storageData, error: storageError } = await supabaseAdmin
                .storage
                .from('generated-images')
                .upload(filename, imageBuffer, {
                    contentType: outputMime,
                    upsert: false
                });

            if (storageError) {
                throw new Error(`Storage upload failed: ${storageError.message}`);
            }

            // Get Public URL
            const { data: publicUrlData } = supabaseAdmin
                .storage
                .from('generated-images')
                .getPublicUrl(filename);
                
            const finalUrl = publicUrlData.publicUrl;
            
            // 6. Track the configured image-model estimate (customer-funded calls cost no provider spend)
            const estimatedCost = ownKey ? 0 : CostEstimator.priceOf('gemini-image');
            const latencyMs = Date.now() - startTime;

            // 7. Complete Log
            await supabaseAdmin.from('generation_logs').update({
                status: 'success',
                output_image_ids: finalUrl,
                latency_ms: latencyMs,
                generation_duration: latencyMs,
                estimated_cost: estimatedCost,
                outputs_used: 1
            }).eq('id', logId);

            return {
                success: true,
                url: finalUrl,
                latencyMs,
                cost: estimatedCost,
                fundedBy: ownKey ? 'byok' : 'platform'
            };
        } catch (error) {
            const latencyMs = Date.now() - startTime;
            console.error('[ImageService] Generation failed:', error);
            if (options.ai_run_id) {
                // If logId exists, we ideally want to update it. We don't have it in scope if it failed before logging.
                // Assuming it failed after logging attempt
                try {
                    await supabaseAdmin.from('generation_logs').update({
                        status: 'failed',
                        error_message: error.message,
                        failure_reason: error.message,
                        latency_ms: latencyMs,
                        generation_duration: latencyMs
                    }).eq('ai_run_id', options.ai_run_id).eq('status', 'started');
                } catch(e) {}
            }
            throw error;
        }
    }
}

module.exports = ImageService;
