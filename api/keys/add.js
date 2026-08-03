// api/keys/add.js
const { supabaseAdmin } = require('../../lib/supabase');
const { requireAuth } = require('../../lib/auth');
const { encryptKey } = require('../../lib/keyVault');
const { validateProviderKey } = require('../../lib/providers');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = requireAuth(req, res);
  if (!user) return;

  const { provider, apiKey } = req.body;
  if (!provider || !apiKey) {
    return res.status(400).json({ error: 'provider and apiKey are required' });
  }

  // Cheap test call so bad keys are caught here, not mid-generation later
  const isValid = await validateProviderKey(provider, apiKey);
  if (!isValid) {
    return res.status(400).json({ error: 'That key was rejected by the provider — double check it.' });
  }

  const encrypted = encryptKey(apiKey);

  const { error } = await supabaseAdmin
    .from('user_api_keys')
    .upsert(
      { user_id: user.id, provider, encrypted_key: encrypted, last_validated_at: new Date().toISOString() },
      { onConflict: 'user_id,provider' }
    );

  if (error) return res.status(500).json({ error: 'Could not save key' });

  // Only ever return a masked version — never the raw key
  res.status(200).json({ provider, masked: `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}` });
}
