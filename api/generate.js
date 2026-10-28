try {
    const { waitUntil } = require('@vercel/functions');
    const { validateProviderKey, callProvider } = require('../lib/providers');
    const { requireAuth } = require('../lib/auth');
    const { supabaseAdmin } = require('../lib/supabase');
    const ProductService = require('../lib/product_service');
    const WorkspaceService = require('../lib/workspace_service');
    const { getUserProviderKey } = require('../lib/userKeys');
    const { reserveAllowance } = require('../lib/generation_billing');
    const { requireGenerateRateLimit } = require('../lib/ratelimit');
    const db = require('../database');

    async function handler(req, res) {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const user = requireAuth(req, res);
        if (!user) return; // response already sent

        const { productId, provider, model, prompt, imageBase64 } = req.body || {};
        if (provider !== 'gemini') return res.status(400).json({ error: 'Choose the Gemini image editor.' });
        if (!productId || typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'productId and prompt are required.' });

        // Strict product ownership verification:
        // Protects against unauthorized association, generation, or repointing of other users' products
        let verifiedProduct = null;
        if (productId) {
            try {
                const product = await ProductService.getProductById(productId);
                if (!product) {
                    return res.status(404).json({ error: 'Product not found.' });
                }
                const workspace = await WorkspaceService.getOrCreateWorkspace(user.id);
                if (product.workspace_id !== workspace.id) {
                    return res.status(403).json({ error: 'Unauthorized: Product does not belong to your workspace.' });
                }
                verifiedProduct = product;
            } catch (err) {
                if (err.message && err.message.includes('not found')) {
                    return res.status(404).json({ error: 'Product not found.' });
                }
                console.error('[generate] Product verification error:', err);
                return res.status(500).json({ error: 'Failed to verify product ownership.' });
            }
        }

        if (typeof imageBase64 !== 'string' || !imageBase64.startsWith('data:image/')) return res.status(400).json({ error: 'A product reference image is required.' });
        const account = await db.getUserById(user.id);
        if (!account?.is_active || !account.email_verified_at) return res.status(403).json({ error: 'An active, verified account is required.' });
        let allowed = false;
        req.user = { userId: user.id };
        await requireGenerateRateLimit(req, res, () => { allowed = true; });
        if (!allowed) return;
        const apiKey = await getUserProviderKey(user.id, 'gemini');
        if (!apiKey) return res.status(402).json({ error: 'Add your Gemini API key in Settings.', code: 'BYOK_REQUIRED' });
        // 3. Create run record
        const runId = await db.createAIRun(user.id, productId, null, prompt, 1, 1);
        let allowance;
        try { allowance = await reserveAllowance(user.id, 1); }
        catch (error) {
            await db.updateAIRun(runId, { status: 'failed' });
            return res.status(429).json({ error: error.message });
        }
        // 4. Fire Async Generation Task using @vercel/functions waitUntil
        waitUntil((async () => {
            try {
                const outputUrl = await callProvider({ provider, apiKey, imageBase64, prompt, userId: user.id });
                if (!outputUrl) {
                    throw new Error('Provider returned empty output URL');
                }

                let storagePath = outputUrl;

                // If base64 data, upload to Supabase Storage product-images
                if (outputUrl.startsWith('data:image/')) {
                    const mime = outputUrl.match(/data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*,.*/)?.[1] || 'image/png';
                    const ext = mime.split('/')[1] || 'png';
                    const base64Data = outputUrl.replace(/^data:image\/\w+;base64,/, '');
                    const buffer = Buffer.from(base64Data, 'base64');
                    const filename = `${user.id}/${runId}_${Date.now()}.${ext}`;

                    const { error: uploadError } = await supabaseAdmin.storage
                        .from('product-images')
                        .upload(filename, buffer, { contentType: mime, upsert: true });

                    if (uploadError) {
                        throw new Error(`Failed to store generated asset in bucket: ${uploadError.message}`);
                    }

                    const { data: publicUrlData } = supabaseAdmin.storage
                        .from('product-images')
                        .getPublicUrl(filename);

                    storagePath = publicUrlData?.publicUrl || filename;
                }

                // Insert durable record into outputs table
                const { data: outputRecord, error: outputError } = await supabaseAdmin
                    .from('outputs')
                    .insert({
                        product_id: productId || null,
                        type: 'image',
                        engine: provider,
                        format: '1:1',
                        status: 'completed',
                        storage_path: storagePath,
                        metadata: { prompt, run_id: runId, provider }
                    })
                    .select()
                    .single();

                if (outputError) {
                    throw new Error(`Failed to persist output record: ${outputError.message}`);
                }

                // Bind as primary output for product if not yet set
                if (verifiedProduct && outputRecord?.id) {
                    try {
                        const { data: prod } = await supabaseAdmin
                            .from('products')
                            .select('primary_output_id')
                            .eq('id', verifiedProduct.id)
                            .eq('workspace_id', verifiedProduct.workspace_id)
                            .single();
                        if (prod && !prod.primary_output_id) {
                            await supabaseAdmin
                                .from('products')
                                .update({ primary_output_id: outputRecord.id })
                                .eq('id', verifiedProduct.id)
                                .eq('workspace_id', verifiedProduct.workspace_id);
                        }
                    } catch (e) {
                        console.warn(`[generate] Warning: could not set primary_output_id: ${e.message}`);
                    }
                }

                // Finalize success ONLY after the asset is durably stored and recorded in database:
                await db.updateAIRun(runId, { status: 'completed', funded_by: 'byok', provider_cost: 0, outputs_used: 1 });
            } catch (err) {
                console.error("Async Generation Failed:", err);
                await db.updateAIRun(runId, { status: 'failed' });
                await db.releaseGenerationQuota(user.id, allowance);
            }
        })());

        return res.status(202).json({ 
            message: 'Generation started',
            runId: runId
        });
    };
    module.exports = async (req, res) => {
        try { return await handler(req, res); }
        catch (error) {
            console.error('[generate] Request failed:', error.message);
            return res.status(500).json({ error: 'Could not start generation. Please retry.' });
        }
    };

} catch (e) {
    module.exports = (req, res) => res.status(500).json({ error: "Initialization failed"});
}
