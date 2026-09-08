const { createClient } = require('@supabase/supabase-js');

// Shared admin client — used by serverless functions that need to bypass RLS
// (webhooks, key storage, entitlement checks). Never expose this key to the client.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const missingSupabaseEnv = [];
if (!SUPABASE_URL) missingSupabaseEnv.push('SUPABASE_URL');
if (!SUPABASE_SERVICE_ROLE_KEY) missingSupabaseEnv.push('SUPABASE_SERVICE_ROLE_KEY');

const isSupabaseConfigured = missingSupabaseEnv.length === 0;

let supabaseAdmin;

if (isSupabaseConfigured) {
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false }
    });
} else {
    // createClient() throws on a missing URL. Doing that here, at import time,
    // kills the entire serverless function before Express ever loads a route —
    // which is what surfaces to users as an opaque FUNCTION_INVOCATION_FAILED.
    // Boot anyway with a stub so static pages and non-DB routes still serve,
    // and let routes that genuinely need the database fail with a message that
    // names the missing variable.
    const message =
        `Supabase is not configured: missing ${missingSupabaseEnv.join(', ')}. ` +
        `Set these in the Vercel project (Settings -> Environment Variables) and redeploy.`;
    console.error(`[config] ${message}`);

    supabaseAdmin = new Proxy({}, {
        get(_target, prop) {
            // Let inspection/serialisation probe the object without exploding.
            if (typeof prop === 'symbol' || prop === 'inspect' || prop === 'toJSON') return undefined;
            throw new Error(message);
        },
        apply() { throw new Error(message); }
    });
}

module.exports = { supabaseAdmin, isSupabaseConfigured, missingSupabaseEnv };
