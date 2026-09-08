#!/usr/bin/env node
// scripts/grant_admin.js
// Grants (or revokes) admin on an existing account.
//
// There is deliberately no bootstrap path in the application: admin is a claim
// on the ordinary session JWT backed by users.is_admin, so the first admin has
// to be set out of band. Sign up through the app first, then run this.
//
//   node scripts/grant_admin.js you@example.com
//   node scripts/grant_admin.js you@example.com --revoke
require('dotenv').config();

const email = process.argv[2];
const revoke = process.argv.includes('--revoke');

if (!email || email.startsWith('--')) {
    console.error('Usage: node scripts/grant_admin.js <email> [--revoke]');
    process.exit(1);
}

(async () => {
    const { supabaseAdmin, isSupabaseConfigured, missingSupabaseEnv } = require('../lib/supabase');
    if (!isSupabaseConfigured) {
        console.error(`Supabase is not configured: missing ${missingSupabaseEnv.join(', ')}`);
        process.exit(1);
    }

    const { data: found, error: readErr } = await supabaseAdmin
        .from('users')
        .select('id, email, is_admin, password_hash')
        .ilike('email', email);

    if (readErr) {
        console.error(`Lookup failed: ${readErr.message}`);
        process.exit(1);
    }

    if (!found || found.length === 0) {
        console.error(`No account with email ${email}.`);
        console.error('Sign up through the app first — this only flips a flag on an existing row.');
        process.exit(1);
    }

    const user = found[0];
    const { error } = await supabaseAdmin
        .from('users')
        .update({ is_admin: !revoke })
        .eq('id', user.id);

    if (error) {
        console.error(`Update failed: ${error.message}`);
        process.exit(1);
    }

    console.log(`${revoke ? 'Revoked admin on' : 'Granted admin to'} ${user.email}`);
    if (!user.password_hash) {
        console.log('Note: this account has no password set, so it cannot sign in yet.');
    }
})().catch((e) => { console.error(e.message); process.exit(1); });
