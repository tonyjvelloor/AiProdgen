// lib/commissions.js
//
// The commission calculation contract (Agency Reseller V2, Release D):
//
//   eligible payment -> determine SKU -> determine commissionability ->
//   calculate commission -> create immutable ledger record -> eligible_at -> payout
//
// This file is only the second and third arrows: a pure, deterministic
// function from a payment's own facts to a commission amount, or to "not
// commissionable." No I/O, no database, no Razorpay -- lib/referrals.js does
// the ledger writes and calls this. Keeping the math here, alone, is what
// makes it testable without a database and reviewable without reading the
// ledger code at all.
const INITIAL_RATE = 0.20;   // 20% on the referred customer's first eligible purchase
const RECURRING_RATE = 0.10; // 10% on eligible recurring purchases
const RECURRING_MONTHS = 12; // ...for this many months from the first conversion

// A SKU has to be explicitly listed here to ever generate a commission --
// this is the actual enforcement of "don't commission the AI-compute
// pass-through." Credit packs (`kind: 'credits'`) are never commissionable
// in V1 regardless of this list; feature unlocks stay off by default until
// added here once their margin is known.
const COMMISSIONABLE_PLANS = new Set(['hobbyist_ltd', 'agency_ltd', 'agency_pro']);

function isCommissionable({ kind, planId }) {
    if (kind !== 'plan') return false;
    return COMMISSIONABLE_PLANS.has(planId);
}

// grossAmountCents is the payment's own amount, in the smallest currency
// unit -- matches `payments.amount` / db.recordPayment's `amount`. Commission
// is computed on that gross figure, before Razorpay's fee, matching the
// worked example: $197 (19700) x 20% = $39.40 (3940).
function calculateCommission({ kind, planId, grossAmountCents, currency = 'USD', commissionType = 'initial' }) {
    if (!isCommissionable({ kind, planId })) {
        return { commissionable: false, commissionAmountCents: 0, rate: 0, commissionType, currency };
    }
    if (!Number.isFinite(grossAmountCents) || grossAmountCents <= 0) {
        return { commissionable: false, commissionAmountCents: 0, rate: 0, commissionType, currency };
    }
    const rate = commissionType === 'recurring' ? RECURRING_RATE : INITIAL_RATE;
    const commissionAmountCents = Math.round(grossAmountCents * rate);
    return { commissionable: true, commissionAmountCents, rate, commissionType, currency };
}

module.exports = {
    INITIAL_RATE,
    RECURRING_RATE,
    RECURRING_MONTHS,
    COMMISSIONABLE_PLANS,
    isCommissionable,
    calculateCommission
};
