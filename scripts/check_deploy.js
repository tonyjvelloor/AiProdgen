#!/usr/bin/env node
// scripts/check_deploy.js
// Pre-flight for a deploy: verifies env config, Supabase reachability, and that
// every table the application code queries actually exists.
//
//   node scripts/check_deploy.js
require('dotenv').config();

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET', 'KEY_ENCRYPTION_SECRET'];
const OPTIONAL_ENV = ['GEMINI_API_KEY', 'REPLICATE_API_TOKEN', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'UPSTASH_REDIS_REST_URL', 'SENTRY_DSN'];

// Every table reached via supabaseAdmin.from(...) in server.js, database.js, lib/ and api/.
const TABLES = [
    'ai_runs', 'auth_tokens', 'credit_transactions', 'generation_logs', 'generations',
    'output_authorizations', 'output_collections', 'outputs', 'products', 'provider_calls',
    'provider_registry', 'user_api_keys', 'user_entitlements', 'users',
    'webhook_events', 'workspaces',
    // added by migrations/001_production_readiness.sql
    'pending_orders', 'ugc_projects', 'gallery_items', 'upscale_usage',
    // added by migrations/002_async_job_ownership.sql
    'async_jobs',
    // added by migrations/003_revenue_ledger.sql
    'payments'
];

// Columns the code writes that the original Supabase schema never had.
const COLUMNS = {
    users: ['password_hash', 'is_active', 'is_admin', 'plan', 'billing_cycle', 'monthly_gen_count', 'monthly_ugc_count', 'usage_period_start'],
    credit_transactions: ['source', 'reference_id'],
    // added by migrations/004_usage_attribution.sql
    ai_runs: ['funded_by']
};

let failed = false;
const bad = (m) => { failed = true; console.log(`  FAIL  ${m}`); };
const ok = (m) => console.log(`  ok    ${m}`);

(async () => {
    console.log('\nEnvironment');
    for (const k of REQUIRED_ENV) process.env[k] ? ok(k) : bad(`${k} is not set`);
    const present = OPTIONAL_ENV.filter((k) => process.env[k]);
    console.log(`  --    optional set: ${present.join(', ') || 'none'}`);

    console.log('\nSecret formats');
    const kes = process.env.KEY_ENCRYPTION_SECRET;
    if (!kes) bad('KEY_ENCRYPTION_SECRET missing');
    else if (/^[0-9a-fA-F]{64}$/.test(kes) || Buffer.from(kes, 'utf-8').length === 32) {
        try { require('../lib/keyVault').decryptKey(require('../lib/keyVault').encryptKey('x')); ok('KEY_ENCRYPTION_SECRET encrypt/decrypt round-trip'); }
        catch (e) { bad(`keyVault round-trip: ${e.message}`); }
    } else bad('KEY_ENCRYPTION_SECRET must be 64 hex chars (openssl rand -hex 32)');

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.log('\nSkipping database checks — Supabase is not configured.\n');
        process.exit(1);
    }

    console.log('\nDatabase');
    const { supabaseAdmin } = require('../lib/supabase');
    try {
        const { error } = await supabaseAdmin.from('users').select('id').limit(1);
        if (error && !/does not exist|schema cache/i.test(error.message)) throw new Error(error.message);
        ok(`reachable at ${process.env.SUPABASE_URL}`);
    } catch (e) {
        bad(`unreachable: ${e.message}`);
        console.log('\n  If this is a 521 / fetch failure, the Supabase project is probably paused.');
        console.log('  Restore it from the dashboard, then re-run.\n');
        process.exit(1);
    }

    console.log('\nTables');
    const missing = [];
    for (const t of TABLES) {
        const { error } = await supabaseAdmin.from(t).select('*').limit(0);
        if (error) { missing.push(t); bad(`${t} — ${error.message}`); } else ok(t);
    }

    console.log('\nColumns');
    for (const [table, cols] of Object.entries(COLUMNS)) {
        for (const c of cols) {
            const { error } = await supabaseAdmin.from(table).select(c).limit(0);
            if (error) { missing.push(`${table}.${c}`); bad(`${table}.${c} — missing`); }
            else ok(`${table}.${c}`);
        }
    }

    console.log('');
    if (missing.length) {
        console.log(`${missing.length} missing object(s). Apply migrations/001_production_readiness.sql`);
        console.log('in the Supabase SQL editor, then re-run this check.\n');
    }
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\ncheck_deploy crashed:', e.message, '\n'); process.exit(1); });
