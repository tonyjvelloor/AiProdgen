const { supabaseAdmin } = require('../../lib/supabase');
const { requireAuth } = require('../../lib/auth');
const { invalidateUserProviderKey } = require('../../lib/userKeys');

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();
    const user = requireAuth(req, res);
    if (!user) return;
    const provider = req.body?.provider || 'gemini';
    if (!['gemini', 'replicate'].includes(provider)) return res.status(400).json({ error: 'Unsupported provider' });
    const { error } = await supabaseAdmin.from('user_api_keys').delete().eq('user_id', user.id).eq('provider', provider);
    if (error) return res.status(500).json({ error: 'Could not remove API key' });
    invalidateUserProviderKey(user.id, provider);
    return res.json({ success: true });
};
