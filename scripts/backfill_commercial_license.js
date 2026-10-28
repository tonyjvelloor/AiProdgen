#!/usr/bin/env node
// Add the commercial right already advertised to existing paid buyers.
// Dry run by default. Review the count before running with --apply.
require('dotenv').config();
const { supabaseAdmin } = require('../lib/supabase');
const { grantEntitlement, FEATURES } = require('../lib/entitlements');
(async () => {
    const { data: users, error } = await supabaseAdmin.from('users').select('id, plan')
        .in('plan', ['hobbyist_ltd', 'pro_founder_ltd', 'agency_ltd', 'lifetime_founder', 'creator', 'pro', 'agency']).eq('is_active', true);
    if (error) throw error;
    const apply = process.argv.includes('--apply');
    console.log(`${apply ? 'Applying' : 'Dry run:'} commercial access for ${users.length} active paid account(s).`);
    if (!apply) return;
    for (const user of users) {
        await grantEntitlement({ userId: user.id, feature: FEATURES.COMMERCIAL_LICENSE, source: 'plan', referenceId: user.plan });
    }
    console.log('Commercial grants complete. No credits, plans, or existing access were removed.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
