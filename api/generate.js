// api/generate.js
const { waitUntil } = require('@vercel/functions');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth } = require('../lib/auth');
const { decryptKey } = require('../lib/keyVault');
const { callProvider } = require('../lib/providers'); 

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = requireAuth(req, res);
  if (!user) return; // requireAuth already sent the 401

  // Gate on entitlement, not a plan flag
  const { data: entitlement } = await supabaseAdmin
    .from('user_entitlements')
    .select('id')
    .eq('user_id', user.id)
    .eq('product_id', 'core_platform')
    .maybeSingle();

  if (!entitlement) {
    return res.status(403).json({ error: 'No active plan for this account' });
  }

  const { provider, imageBase64, prompt } = req.body;

  const { data: keyRow } = await supabaseAdmin
    .from('user_api_keys')
    .select('encrypted_key')
    .eq('user_id', user.id)
    .eq('provider', provider)
    .maybeSingle();

  if (!keyRow) {
    return res.status(400).json({ error: `No ${provider} API key on file — add one in settings.` });
  }

  // Insert pending row, respond immediately
  const { data: generation, error } = await supabaseAdmin
    .from('generations')
    .insert({ user_id: user.id, status: 'pending', provider })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Could not start generation' });

  res.status(202).json({ id: generation.id, status: 'pending' });

  // Continue processing after the response has been sent
  waitUntil((async () => {
    try {
      const apiKey = decryptKey(keyRow.encrypted_key);
      const imageUrl = await callProvider({ provider, apiKey, imageBase64, prompt, userId: user.id });

      await supabaseAdmin
        .from('generations')
        .update({ status: 'complete', image_url: imageUrl })
        .eq('id', generation.id);
    } catch (err) {
      console.error('Generation failed:', err);
      await supabaseAdmin
        .from('generations')
        .update({ status: 'failed' })
        .eq('id', generation.id);
    }
  })());
}
