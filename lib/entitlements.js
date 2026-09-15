// lib/entitlements.js
//
// PLANS in server.js has always carried bulk/commercial/watermark/templates
// flags, but no route ever checked them -- a plan's included feature access
// and its metered compute (credits, BYOK) were never actually separable,
// because both lived only as fields on a hardcoded plan object. That made it
// impossible to sell a feature (e.g. "Commercial License") as its own
// purchase without inventing a new fake plan tier for it.
//
// This module is the feature-grant layer: "can this user use X" (an
// entitlements row) is now independent of "who pays for the compute" (the
// credit ledger in database.js, or a BYOK key in userKeys.js).
//
// THE CONTRACT
// ------------
// `source` says why a grant exists, and controls how re-granting behaves:
//   - 'plan'      Derived from the user's current plan. Exactly one active
//                  row per (user, feature): seedPlanEntitlements() re-points
//                  it at the new plan on upgrade/downgrade, or revokes it if
//                  the new plan doesn't include the feature. Never stacks.
//   - 'purchase'   A standalone, one-time paid unlock (e.g. Bulk Studio).
//                  Keyed by (user, feature, reference_id=payment id), so two
//                  distinct payments for the same feature both grant -- that
//                  is how a repeat consumable purchase (a second credit pack)
//                  is meant to stack instead of being deduped away.
//   - 'admin_grant' Manually granted (support/goodwill). Same stacking rule
//                  as 'purchase'.
//   - 'promotion'  Granted by a campaign (referral, launch offer), usually
//                  with an expires_at. Same stacking rule as 'purchase'.
//   - 'trial'      Time-boxed taste of a feature. Always set expires_at.
//                  Same stacking rule as 'purchase'.
//
// `quantity` distinguishes the two shapes a grant can take:
//   - null       Boolean feature: on/off for as long as the grant is active.
//                 This is what plan-derived flags are (bulk/commercial/
//                 watermark_removal/premium_templates), and what a permanent
//                 one-time unlock like "Bulk Studio" should use too --
//                 buying it does not meter how many times you use it.
//   - a number   Consumable entitlement: a pool that consumeEntitlement()
//                 spends down (e.g. a "10 HD upscales" pack). remaining_
//                 quantity tracks what's left; the grant stops counting as
//                 active once it hits zero. Reserve this for features sold
//                 as a metered pack, not for permanent unlocks.
//
// Consuming from a limited grant goes through the consume_entitlement
// Postgres function (see migrations/006_entitlements.sql), not a JS
// read-then-write -- two concurrent requests against remaining_quantity=1
// must not both succeed, and only a single-statement, row-locked SQL
// transaction actually guarantees that.
const { supabaseAdmin } = require('./supabase');

const SOURCES = {
    PLAN: 'plan',
    PURCHASE: 'purchase',
    ADMIN_GRANT: 'admin_grant',
    PROMOTION: 'promotion',
    TRIAL: 'trial'
};

// Known feature keys. Anything not listed here can still be granted (the
// column is free-text), but routes should reference this object rather than
// string literals so a typo fails loudly instead of silently never matching.
const FEATURES = {
    BULK_GENERATION: 'bulk_generation',
    COMMERCIAL_LICENSE: 'commercial_license',
    WATERMARK_REMOVAL: 'watermark_removal',
    PREMIUM_TEMPLATES: 'premium_templates',
    HD_UPSCALE: 'hd_upscale',
    FACE_CONSISTENCY: 'face_consistency',
    BRAND_KIT: 'brand_kit',
    PRIORITY_QUEUE: 'priority_queue'
};

function isExpired(row) {
    return !!row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
}

function isExhausted(row) {
    return row.remaining_quantity !== null && row.remaining_quantity !== undefined && row.remaining_quantity <= 0;
}

// All active, unexpired, unexhausted grants for a feature, most recently
// created first -- consume() spends from these in that order.
async function activeGrants(userId, feature) {
    const { data, error } = await supabaseAdmin
        .from('entitlements')
        .select('*')
        .eq('user_id', userId)
        .eq('feature', feature)
        .eq('status', 'active')
        .order('created_at', { ascending: false });
    if (error) throw new Error(`entitlements lookup failed: ${error.message}`);
    return (data || []).filter(row => !isExpired(row) && !isExhausted(row));
}

async function hasFeature(userId, feature) {
    if (!userId) return false;
    const grants = await activeGrants(userId, feature);
    return grants.length > 0;
}

// Grants are additive, but re-seeding on every plan verify should not pile up
// duplicate rows. Plan-sourced grants dedupe per (user, feature, source) --
// a user has exactly one active plan, so re-seeding updates the existing
// grant's reference_id (which plan granted it) rather than inserting a
// second active row. Purchase-sourced grants dedupe per (user, feature,
// source, reference_id) instead: two distinct payments for the same feature
// are meant to each grant, so a repeat purchase can stack.
async function grantEntitlement({ userId, feature, source = 'plan', quantity = null, expiresAt = null, referenceId = null, metadata = {} }) {
    if (!userId || !feature) throw new Error('grantEntitlement requires userId and feature');

    let existingQuery = supabaseAdmin
        .from('entitlements')
        .select('id, expires_at, status, reference_id')
        .eq('user_id', userId)
        .eq('feature', feature)
        .eq('source', source)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1);
    if (source !== 'plan') existingQuery = existingQuery.eq('reference_id', referenceId);
    const { data: existingRows, error: lookupError } = await existingQuery;
    if (lookupError) throw new Error(`entitlements lookup failed: ${lookupError.message}`);
    const existing = existingRows && existingRows[0];

    if (existing && !isExpired(existing)) {
        if (source === 'plan' && existing.reference_id !== referenceId) {
            const { data, error } = await supabaseAdmin
                .from('entitlements')
                .update({ reference_id: referenceId, updated_at: new Date().toISOString() })
                .eq('id', existing.id)
                .select()
                .single();
            if (error) throw new Error(`grantEntitlement failed: ${error.message}`);
            return data;
        }
        return existing;
    }

    const { data, error } = await supabaseAdmin
        .from('entitlements')
        .insert({
            user_id: userId,
            feature,
            source,
            quantity,
            remaining_quantity: quantity,
            expires_at: expiresAt,
            reference_id: referenceId,
            metadata,
            status: 'active'
        })
        .select()
        .single();
    if (error) throw new Error(`grantEntitlement failed: ${error.message}`);
    return data;
}

// referenceId omitted (or null) revokes every active grant for the feature
// from this source, regardless of which reference originally granted it --
// used when re-seeding a plan drops a feature the user's old plan included.
// Pass referenceId to revoke only that specific grant (e.g. one purchase).
async function revokeEntitlement(userId, feature, source = 'plan', referenceId = null) {
    let query = supabaseAdmin.from('entitlements')
        .update({ status: 'revoked', updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('feature', feature)
        .eq('source', source)
        .eq('status', 'active');
    if (referenceId !== null) query = query.eq('reference_id', referenceId);
    const { error } = await query;
    if (error) throw new Error(`revokeEntitlement failed: ${error.message}`);
    return true;
}

// For refunds: a Razorpay refund event carries the payment id but not
// necessarily which user/feature it granted (notes can be absent or
// tampered with client-side before capture). reference_id is set to the
// payment id at grant time and is unique per payment, so revoking by it
// alone is both sufficient and safer than trusting the event's own notes.
async function revokeEntitlementByReference(referenceId) {
    if (!referenceId) return false;
    const { error } = await supabaseAdmin.from('entitlements')
        .update({ status: 'revoked', updated_at: new Date().toISOString() })
        .eq('reference_id', referenceId)
        .eq('status', 'active');
    if (error) throw new Error(`revokeEntitlementByReference failed: ${error.message}`);
    return true;
}

// Spends `amount` from a user's quantity-limited grants for `feature` via the
// consume_entitlement Postgres function (migrations/006_entitlements.sql),
// which locks the user's rows for this feature (SELECT ... FOR UPDATE) inside
// one transaction before deciding and writing. A JS read-then-conditional-
// write can only detect that a concurrent spend won the race after the fact;
// it can't prevent two concurrent callers both reading remaining_quantity=1
// and both believing they're entitled to spend it. Row locking is what
// actually guarantees only one does. Unlimited grants (quantity === null)
// short-circuit to true without touching any row.
async function consumeEntitlement(userId, feature, amount = 1) {
    const { data, error } = await supabaseAdmin.rpc('consume_entitlement', {
        p_user_id: userId,
        p_feature: feature,
        p_amount: amount
    });
    if (error) throw new Error(`consumeEntitlement failed: ${error.message}`);
    return data === true;
}

async function getUserEntitlements(userId) {
    const { data, error } = await supabaseAdmin
        .from('entitlements')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false });
    if (error) throw new Error(`entitlements lookup failed: ${error.message}`);
    return (data || []).filter(row => !isExpired(row) && !isExhausted(row));
}

// Express middleware: gate a route behind a feature grant. Kept separate from
// the plan-flag checks already in server.js (planConfig.veo, .director, ...)
// -- this is for features sold as their own unlock, not bundled plan limits.
function requireFeature(feature) {
    return async (req, res, next) => {
        try {
            const userId = req.user && req.user.userId;
            if (!userId) return res.status(401).json({ error: 'Authentication required' });
            if (await hasFeature(userId, feature)) return next();
            return res.status(402).json({
                error: `This requires the "${feature}" unlock.`,
                code: 'FEATURE_REQUIRED',
                feature
            });
        } catch (e) {
            console.error(`[entitlements] requireFeature(${feature}) failed:`, e.message);
            return res.status(500).json({ error: 'Could not verify feature access' });
        }
    };
}

// Re-derives a plan's included feature grants. Called whenever a plan is
// activated (signup purchase, in-app upgrade) so the bulk/commercial/
// watermark/templates flags that have sat unused on PLANS actually grant
// something. Idempotent: re-running for the same plan does not duplicate
// grants (see grantEntitlement's existing-row check), and previously-granted
// features no longer on the plan are revoked so a downgrade actually removes
// access instead of leaving stale grants behind.
async function seedPlanEntitlements(userId, planId, planConfig) {
    const wanted = [];
    if (planConfig.bulk) wanted.push(FEATURES.BULK_GENERATION);
    if (planConfig.commercial) wanted.push(FEATURES.COMMERCIAL_LICENSE);
    if (planConfig.watermark === false) wanted.push(FEATURES.WATERMARK_REMOVAL);
    if (planConfig.templates && planConfig.templates !== 'none') wanted.push(FEATURES.PREMIUM_TEMPLATES);

    for (const feature of Object.values(FEATURES)) {
        if (wanted.includes(feature)) {
            await grantEntitlement({ userId, feature, source: 'plan', referenceId: planId });
        } else {
            // No referenceId: clears a plan-sourced grant left over from
            // whatever plan the user was on before, not just this one.
            await revokeEntitlement(userId, feature, 'plan');
        }
    }
    return wanted;
}

module.exports = {
    FEATURES,
    SOURCES,
    hasFeature,
    grantEntitlement,
    revokeEntitlement,
    revokeEntitlementByReference,
    consumeEntitlement,
    getUserEntitlements,
    requireFeature,
    seedPlanEntitlements
};
