// lib/referrals.js
//
// The ledger layer for the Partner Program (Agency Reseller V2, Release D).
// lib/commissions.js is the pure calculation contract; this file is the I/O
// around it -- attribution, creating the ledger record at the exact moment
// an eligible payment is recorded, the hold-window lazy-approval, and
// refund reversal.
//
// Kept out of lib/entitlements.js on purpose: a commission is a financial
// ledger entry, never a feature grant, and the two must not be confused in
// an audit. Nothing here writes to `entitlements`; nothing in entitlements.js
// reads `referrals` or `commissions`.
const crypto = require('crypto');
const { supabaseAdmin } = require('./supabase');
const { isCommissionable, calculateCommission, RECURRING_MONTHS } = require('./commissions');

const ATTRIBUTION_WINDOW_DAYS = 30;
const HOLD_WINDOW_DAYS = 30;
// $25 / Rs.2,000, in the smallest currency unit -- currency-naive for V1
// (payouts are manual and cross-currency amounts are small in volume).
const MIN_PAYOUT_CENTS = { USD: 2500, INR: 200000 };

function daysFromNow(days) {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function generateCode() {
    return crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 hex chars, e.g. "A1B2C3D4"
}

// Idempotent: returns the existing code if the user already has one. The
// presence of a code IS partner status in V1 -- there is no separate
// `partners` table or opt-in flag, since V1 ships exactly one partner type
// (spec §17).
async function getOrCreateReferralCode(userId) {
    const { data: existing, error: lookupError } = await supabaseAdmin.from('users').select('referral_code').eq('id', userId).maybeSingle();
    if (lookupError) throw new Error(`getOrCreateReferralCode lookup failed: ${lookupError.message}`);
    if (existing && existing.referral_code) return existing.referral_code;

    // A random 4-byte hex collision is astronomically unlikely at this
    // codebase's scale, but must not throw an unhandled 23505 if it happens.
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateCode();
        const { data, error } = await supabaseAdmin.from('users').update({ referral_code: code }).eq('id', userId).select('referral_code').maybeSingle();
        if (!error && data) return data.referral_code;
        if (error && error.code !== '23505') throw new Error(`getOrCreateReferralCode failed: ${error.message}`);
    }
    throw new Error('Could not allocate a unique referral code after 5 attempts');
}

async function findReferrerByCode(code) {
    if (!code) return null;
    const { data } = await supabaseAdmin.from('users').select('id').eq('referral_code', code).maybeSingle();
    return data ? data.id : null;
}

// Attributes a referral at the moment a NEW account is created. Callers must
// only invoke this from a signup path -- an existing account visiting a
// referral link is never retroactively attributed (spec §22). First valid
// attribution wins for life: a second call for the same referredUserId is a
// silent no-op, enforced by the unique constraint on referrals.referred_user_id
// (migrations/007), not just this check.
async function attributeReferral({ referralCode, referredUserId }) {
    if (!referralCode || !referredUserId) return null;
    const referrerUserId = await findReferrerByCode(referralCode);
    if (!referrerUserId) return null;
    if (referrerUserId === referredUserId) return null; // no self-referral

    const { data, error } = await supabaseAdmin.from('referrals').insert({
        referrer_user_id: referrerUserId,
        referred_user_id: referredUserId,
        referral_code: referralCode,
        attribution_source: 'link',
        status: 'pending'
    }).select().maybeSingle();

    if (error) {
        if (error.code === '23505') return null; // already attributed to whoever referred them first
        throw new Error(`attributeReferral failed: ${error.message}`);
    }
    return data;
}

async function activeReferralFor(referredUserId) {
    const { data, error } = await supabaseAdmin.from('referrals')
        .select('*').eq('referred_user_id', referredUserId).in('status', ['pending', 'converted']).maybeSingle();
    if (error) throw new Error(`activeReferralFor lookup failed: ${error.message}`);
    if (!data) return null;
    if (data.status === 'pending') {
        const withinWindow = (Date.now() - new Date(data.attributed_at).getTime()) <= ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
        if (!withinWindow) return null; // attribution expired before any purchase happened
    }
    return data;
}

// The hook: call this alongside every db.recordPayment(). Silently returns
// null (never throws for an ordinary "no commission here" outcome) when the
// SKU isn't commissionable, the referred user has no active attribution, or
// this payment already has a commission -- the unique constraint on
// commissions.payment_id is the actual guarantee behind that last case
// (Test 2: a duplicate payment.captured must produce exactly one commission).
async function recordEligiblePayment({ userId, paymentId, orderId, kind, planId, grossAmountCents, currency = 'USD' }) {
    if (!isCommissionable({ kind, planId })) return null;
    if (!paymentId || !grossAmountCents) return null;

    const referral = await activeReferralFor(userId);
    if (!referral) return null;

    const isFirstConversion = !referral.converted_at;
    let commissionType = 'initial';
    if (!isFirstConversion) {
        const monthsSince = (Date.now() - new Date(referral.converted_at).getTime()) / (30 * 24 * 60 * 60 * 1000);
        if (monthsSince > RECURRING_MONTHS) return null; // Test 9: outside the 12-month recurring window
        commissionType = 'recurring';
    }

    const calc = calculateCommission({ kind, planId, grossAmountCents, currency, commissionType });
    if (!calc.commissionable) return null;

    const { data, error } = await supabaseAdmin.from('commissions').insert({
        partner_id: referral.referrer_user_id,
        referred_user_id: userId,
        payment_id: paymentId,
        order_id: orderId || null,
        commission_type: calc.commissionType,
        commission_rate: calc.rate,
        gross_amount: grossAmountCents,
        commission_base: grossAmountCents,
        commission_amount: calc.commissionAmountCents,
        currency,
        status: 'pending',
        eligible_at: daysFromNow(HOLD_WINDOW_DAYS)
    }).select().maybeSingle();

    if (error) {
        if (error.code === '23505') return null; // this payment already produced a commission
        throw new Error(`recordEligiblePayment failed: ${error.message}`);
    }

    if (isFirstConversion) {
        await supabaseAdmin.from('referrals').update({ status: 'converted', converted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', referral.id);
    }
    return data;
}

// Refund handling: revoke every commission tied to this payment ID. Mirrors
// entitlements.revokeEntitlementByReference -- and hits the same structural
// limit for a plan purchase (see runbooks/plan-refund.md): this reaches
// commissions by payment_id regardless of what generated them, so it works
// for both a standalone unlock and a plan purchase equally, unlike the
// entitlement revoke path. A commission already marked 'paid' is left alone
// and counted for manual clawback rather than silently reversed.
async function reverseCommissionsForPayment(paymentId) {
    const { data: rows, error: lookupError } = await supabaseAdmin.from('commissions').select('id, status').eq('payment_id', paymentId);
    if (lookupError) throw new Error(`reverseCommissionsForPayment lookup failed: ${lookupError.message}`);
    if (!rows || !rows.length) return { reversed: 0, needsClawback: 0 };

    let reversed = 0, needsClawback = 0;
    for (const row of rows) {
        if (row.status === 'paid') { needsClawback++; continue; }
        const { error } = await supabaseAdmin.from('commissions')
            .update({ status: 'reversed', reversed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', row.id).neq('status', 'paid');
        if (error) throw new Error(`reverseCommissionsForPayment failed: ${error.message}`);
        reversed++;
    }
    if (needsClawback > 0) {
        console.error(`[commissions] payment ${paymentId} refunded but ${needsClawback} commission(s) already paid out -- needs manual clawback.`);
    }
    return { reversed, needsClawback };
}

// Lazy hold-window clearing, same convention as database.js's
// rollUsagePeriodIfStale -- checked on read, no cron job. Also the summary a
// partner dashboard needs (§24: four numbers and a link, nothing more).
async function getPartnerSummary(partnerId) {
    const { data: rows, error } = await supabaseAdmin.from('commissions').select('*').eq('partner_id', partnerId);
    if (error) throw new Error(`getPartnerSummary failed: ${error.message}`);

    const now = Date.now();
    let pendingCents = 0, availableCents = 0, paidCents = 0;
    const toApprove = [];
    for (const row of rows || []) {
        if (row.status === 'pending' && new Date(row.eligible_at).getTime() <= now) {
            toApprove.push(row.id);
            availableCents += row.commission_amount;
        } else if (row.status === 'pending') {
            pendingCents += row.commission_amount;
        } else if (row.status === 'available') {
            availableCents += row.commission_amount;
        } else if (row.status === 'paid') {
            paidCents += row.commission_amount;
        }
    }
    if (toApprove.length) {
        const { error: approveError } = await supabaseAdmin.from('commissions')
            .update({ status: 'available', updated_at: new Date().toISOString() })
            .in('id', toApprove).eq('status', 'pending');
        if (approveError) throw new Error(`getPartnerSummary approve step failed: ${approveError.message}`);
    }

    const { data: referrals, error: refError } = await supabaseAdmin.from('referrals').select('status').eq('referrer_user_id', partnerId);
    if (refError) throw new Error(`getPartnerSummary referral count failed: ${refError.message}`);
    const referralCounts = (referrals || []).reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});

    return {
        pendingCents,
        availableCents,
        paidCents,
        totalEarnedCents: pendingCents + availableCents + paidCents,
        referralCounts,
        // Currency-naive minimum for V1 -- see MIN_PAYOUT_CENTS.
        payoutEligible: availableCents >= MIN_PAYOUT_CENTS.USD
    };
}

// Admin action -- there is no payout API in V1 (spec §18/§24): pay the
// partner off-platform, then record it here.
async function markPaid({ commissionIds, payoutReference, payoutMethod }) {
    if (!commissionIds || !commissionIds.length) return false;
    const { error } = await supabaseAdmin.from('commissions')
        .update({ status: 'paid', paid_at: new Date().toISOString(), payout_reference: payoutReference || null, payout_method: payoutMethod || null, updated_at: new Date().toISOString() })
        .in('id', commissionIds).eq('status', 'available');
    if (error) throw new Error(`markPaid failed: ${error.message}`);
    return true;
}

module.exports = {
    ATTRIBUTION_WINDOW_DAYS,
    HOLD_WINDOW_DAYS,
    MIN_PAYOUT_CENTS,
    getOrCreateReferralCode,
    findReferrerByCode,
    attributeReferral,
    activeReferralFor,
    recordEligiblePayment,
    reverseCommissionsForPayment,
    getPartnerSummary,
    markPaid
};
