// lib/image_service.js

const db = require('../database');
const Replicate = require('replicate');
const { supabaseAdmin } = require('./supabase');

const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
});

/**
 * ImageService
 * Orchestrates AI generation via Replicate (Flux Dev).
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
                userId, 'replicate', 'flux-dev', 0, 0, 0, 0, 0, 'started', null,
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
            
            console.log(`[ImageService] Calling Replicate (Flux Dev) for user ${userId}. Prompt: ${prompt}`);
            
            // 3. Call Replicate
            const output = await replicate.run(
                "black-forest-labs/flux-dev",
                {
                    input: {
                        prompt: prompt,
                        go_fast: true,
                        megapixels: "1",
                        num_outputs: 1,
                        aspect_ratio: aspectRatio.replace(':', ':'), // "1:1", "16:9"
                        output_format: "webp",
                        output_quality: isFreeTier ? 60 : 90
                    }
                }
            );

            // Replicate returns an array of URLs for flux-dev
            const generatedImageUrl = Array.isArray(output) ? output[0] : output;
            if (!generatedImageUrl) {
                throw new Error("Replicate returned empty output");
            }

            // 4. Download Image Buffer from Replicate
            const imageRes = await fetch(generatedImageUrl);
            if (!imageRes.ok) throw new Error("Failed to fetch generated image from Replicate");
            const imageBuffer = await imageRes.arrayBuffer();

            // 5. Upload to Supabase Storage
            const filename = `${userId}/${Date.now()}.webp`;
            const { data: storageData, error: storageError } = await supabaseAdmin
                .storage
                .from('generated-images')
                .upload(filename, imageBuffer, {
                    contentType: 'image/webp',
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
            
            // 6. Track Cost (Flux Dev costs exactly $0.03 per generation)
            const estimatedCost = 0.03;
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
                cost: estimatedCost
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
