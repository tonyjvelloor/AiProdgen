

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

// Wan 2.1 Image-to-Video Model
// Using model-specific endpoint for stability
const WAN_I2V_MODEL_OWNER = "wavespeedai";
const WAN_I2V_MODEL_NAME = "wan-2.1-i2v-720p";

const LTX_MODEL_OWNER = "lightricks";
const LTX_MODEL_NAME = "ltx-2-fast";

const FLUX_MODEL_OWNER = "black-forest-labs";
const FLUX_MODEL_NAME = "flux-schnell";

/**
 * Generate Video from Image
 * @param {string} imageUrl - URL of the source image
 * @param {string} prompt - Text prompt for motion guidance
 * @param {string} model - 'wan' or 'ltx' (default: 'wan')
 */
/**
 * Generate Video from Image
 * @param {string} imageUrl - URL of the source image (or start image)
 * @param {string} prompt - Text prompt for motion guidance
 * @param {string} model - 'wan' or 'ltx' (default: 'wan')
 * @param {object} options - Optional parameters { endImageUrl, directorMode }
 */
// Replicate failures were collapsed into a generic 500 by the routes, so a bad
// token, a missing payment method and a genuine model error were
// indistinguishable from the outside. Attach the provider's own status and
// detail to the error so the route can report something actionable.
function providerError(label, status, detail) {
    const err = new Error(`Replicate API Error (${label}): ${JSON.stringify(detail)}`);
    err.providerStatus = status;
    err.providerDetail = detail && (detail.detail || detail.title || detail.error);
    return err;
}

async function generateVideoFromImage(imageUrl, prompt, model = 'wan', options = {}) {
    // MOCK MODE FOR OFFLINE TESTING
    if (process.env.TEST_MODE === 'true') {
        console.log(`[MOCK] Generating video with model: ${model}, mode: ${options.directorMode}`);
        return {
            id: `mock_video_${Date.now()}`,
            status: 'starting',
            urls: { get: 'http://localhost:3002/api/mock/prediction' } // simplified
        };
    }

    if (!REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN not configured");

    const { endImageUrl, directorMode } = options;
    let owner, name, input;

    if (model === 'ltx') {
        owner = LTX_MODEL_OWNER;
        name = LTX_MODEL_NAME;

        input = {
            image: imageUrl,
            prompt: prompt || "Cinematic camera movement, high quality, 5s",
            aspect_ratio: "16:9",
        };

        // Director Mode Specifics
        if (directorMode === 'morph' && endImageUrl) {
            // Check if LTX supports end_image directly, or we prompt for it
            // Based on research, LTX-2 primarily uses 'image' as start frame.
            // Some implementations use 'end_image' or 'image_end'.
            // If strictly not supported by this endpoint, the prompt is key.
            // We'll try passing it if the schema allows, otherwise rely on prompt.
            // Note: Replicate schemas vary. We'll try 'end_image' as it's common.
            input.end_image = endImageUrl;
            input.prompt = prompt || "Morph smoothly from the first image to the second image, maintaining consistency.";
        } else if (directorMode === 'extend') {
            // For extension, imageUrl is actually the *last frame* of previous clip
            // We treat it as the start frame for the new clip.
            input.prompt = prompt || "Continue the action naturally, high quality, fluid motion";
        }

    } else {
        // Default to Wan 2.1
        owner = WAN_I2V_MODEL_OWNER;
        name = WAN_I2V_MODEL_NAME;
        input = {
            image: imageUrl,
            prompt: prompt || "Cinematic camera movement, high quality, 5s",
            aspect_ratio: "16:9"
        };
    }

    const response = await fetch(`https://api.replicate.com/v1/models/${owner}/${name}/predictions`, {
        method: "POST",
        headers: {
            "Authorization": `Token ${REPLICATE_API_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ input }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: response.statusText }));
        throw new Error(`Replicate API Error (${name}): ${JSON.stringify(error)}`);
    }

    return await response.json();
}

/**
 * Check Prediction Status
 * @param {string} predictionId 
 */
async function getPredictionStatus(predictionId) {
    // MOCK MODE FOR OFFLINE TESTING
    if (process.env.TEST_MODE === 'true' && predictionId.startsWith('mock_')) {
        return {
            id: predictionId,
            status: 'succeeded',
            output: 'https://placehold.co/600x400.png'
        };
    }

    if (!REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN not configured");

    const response = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
        headers: {
            "Authorization": `Token ${REPLICATE_API_TOKEN}`,
            "Content-Type": "application/json",
        },
    });

    if (!response.ok) {
        throw new Error("Failed to get prediction status");
    }

    return await response.json();
}

/**
 * Generate Image using Flux (Schnell)
 * @param {string} prompt 
 * @param {string} aspectRatio - e.g., "1:1", "16:9", "3:2"
 */
async function generateImageFlux(prompt, aspectRatio = "1:1") {
    // MOCK MODE FOR OFFLINE TESTING
    if (process.env.TEST_MODE === 'true') {
        console.log(`[MOCK] Flux generation: ${prompt}`);
        return {
            id: `mock_flux_${Date.now()}`,
            status: 'starting',
            urls: { get: 'http://localhost:3002/api/mock/prediction' }
        };
    }

    if (!REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN not configured");

    const input = {
        prompt: prompt,
        aspect_ratio: aspectRatio,
        output_format: "png",
        output_quality: 90
    };

    const response = await fetch(`https://api.replicate.com/v1/models/${FLUX_MODEL_OWNER}/${FLUX_MODEL_NAME}/predictions`, {
        method: "POST",
        headers: {
            "Authorization": `Token ${REPLICATE_API_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ input }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: response.statusText }));
        throw providerError('Flux', response.status, error);
    }

    return await response.json();
}

/**
 * Generate Scene with Face Consistency (InstantID)
 * @param {string} faceImageUrl - URL or data URI of reference face
 * @param {string} prompt - Scene description
 * @param {object} options - { faceStrength, productImageUrl, seed }
 */
async function generateSceneWithFace(faceImageUrl, prompt, options = {}) {
    if (process.env.TEST_MODE === 'true') {
        console.log(`[MOCK] InstantID scene: ${prompt}`);
        return {
            id: `mock_scene_${Date.now()}`,
            status: 'starting',
            urls: { get: 'http://localhost:3002/api/mock/prediction' }
        };
    }

    if (!REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN not configured");

    const input = {
        image: faceImageUrl,
        prompt: prompt,
        negative_prompt: options.negativePrompt || "blurry, distorted, bad quality, deformed hands, ugly, low quality",
        ip_adapter_scale: options.faceStrength || 0.8,
        controlnet_conditioning_scale: options.poseStrength || 0.8,
        num_inference_steps: 30,
        guidance_scale: 5,
        seed: options.seed || -1
    };

    const response = await fetch(`https://api.replicate.com/v1/models/zsxkib/instant-id/predictions`, {
        method: "POST",
        headers: {
            "Authorization": `Token ${REPLICATE_API_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ input }),
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: response.statusText }));
        throw providerError('InstantID', response.status, error);
    }

    return await response.json();
}

module.exports = {
    generateVideoFromImage,
    getPredictionStatus,
    generateImageFlux,
    generateSceneWithFace
};
