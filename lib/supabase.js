const { createClient } = require('@supabase/supabase-js');

// Shared admin client — used by serverless functions that need to bypass RLS
// (webhooks, key storage, entitlement checks). Never expose this key to the client.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

module.exports = { supabaseAdmin };
