#!/usr/bin/env node
// scripts/backfill_agency_license.js
// Agency Reseller V2, Release B: agency_license and priority_queue were added
// to PLANS.agency_ltd's bundle after some buyers already had the plan active.
// seedPlanEntitlements() only runs when a plan is (re-)activated through a
// purchase route, so anyone who bought before this change would otherwise
// wait indefinitely for a re-verify that may never happen -- despite the
// bundle being strictly additive and already paid for.
//
// Safe to re-run: seedPlanEntitlements() is idempotent per user.
//
//   node scripts/backfill_agency_license.js
require('dotenv').config();

// Mirrors PLANS.agency_ltd in server.js -- keep the feature-relevant fields
// (bulk/commercial/watermark/templates/agency_license/priority) in sync if
// that config ever changes.
const AGENCY_PLAN_CONFIG = {
    bulk: true,
    commercial: true,
    watermark: false,
    templates: 'advanced',
    agency_license: true,
    priority: true
};

(async () => {
    const { supabaseAdmin, isSupabaseConfigured, missingSupabaseEnv } = require('../lib/supabase');
    if (!isSupabaseConfigured) {
        console.error(`Supabase is not configured: missing ${missingSupabaseEnv.join(', ')}`);
        process.exit(1);
    }
    const entitlements = require('../lib/entitlements');

    const { data: users, error } = await supabaseAdmin
        .from('users')
        .select('id, email')
        .eq('plan', 'agency_ltd');

    if (error) {
        console.error(`Lookup failed: ${error.message}`);
        process.exit(1);
    }

    if (!users || users.length === 0) {
        console.log('No users currently on agency_ltd -- nothing to backfill.');
        return;
    }

    console.log(`Backfilling ${users.length} agency_ltd account(s)...`);
    let ok = 0;
    for (const user of users) {
        try {
            const granted = await entitlements.seedPlanEntitlements(user.id, 'agency_ltd', AGENCY_PLAN_CONFIG);
            console.log(`  ok    ${user.email} -> ${granted.join(', ') || '(none)'}`);
            ok++;
        } catch (e) {
            console.error(`  FAIL  ${user.email}: ${e.message}`);
        }
    }
    console.log(`\nDone: ${ok}/${users.length} succeeded.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
