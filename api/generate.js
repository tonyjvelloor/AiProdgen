try {
    const { waitUntil } = require('@vercel/functions');
    const { validateProviderKey, callProvider } = require('../lib/providers');
    const { requireAuth } = require('../lib/auth');
    const { supabaseAdmin } = require('../lib/supabase');
    const keyVault = require('../lib/keyVault');
    const db = require('../database');

    module.exports = async function handler(req, res) {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const user = requireAuth(req, res);
        if (!user) return; // response already sent

        const { productId, provider, model, prompt, imageBase64 } = req.body;

        // 1. Check outputs pool
        const creditsAvailable = await db.getUserCredits(user.id);
        if (creditsAvailable < 1) {
            return res.status(402).json({ error: 'Insufficient outputs. Please top up.' });
        }

        // 2. Fetch User's Key (or fallback)
        const { data: keyData } = await supabaseAdmin.from('user_api_keys')
            .select('encrypted_key')
            .eq('user_id', user.id)
            .eq('provider', provider)
            .single();

        let apiKey = null;
        if (keyData) {
            apiKey = keyVault.decryptKey(keyData.encrypted_key);
        } else {
            // Fallback to system key if allowed for this user/tier (simplified for MVP)
            apiKey = process.env.GEMINI_API_KEY;
        }

        if (!apiKey) {
            return res.status(400).json({ error: 'API key not configured for this provider.' });
        }

        const isValid = await validateProviderKey(provider, apiKey);
        if (!isValid) return res.status(400).json({ error: 'Invalid API key.' });

        // 3. Create run record
        const runId = await db.createAIRun(user.id, productId, null, prompt, 1, 1);
        await db.reserveCredits(user.id, 1, runId);

        // 4. Fire Async Generation Task using @vercel/functions waitUntil
        waitUntil((async () => {
            try {
                // ... async generation logic ...
                const outputUrl = await callProvider({ provider, apiKey, imageBase64, prompt, userId: user.id });
                
                // Finalize success
                await db.updateAIRun(runId, { status: 'completed' });
                await db.commitCredits(user.id, 1, runId);
                // In full implementation, save outputUrl to product_assets
            } catch (err) {
                console.error("Async Generation Failed:", err);
                await db.updateAIRun(runId, { status: 'failed' });
                await db.rollbackCredits(user.id, 1, runId);
            }
        })());

        return res.status(202).json({ 
            message: 'Generation started',
            runId: runId
        });
    };
} catch (e) {
    module.exports = (req, res) => res.status(500).json({ error: "Initialization failed", message: e.message, stack: e.stack });
}
