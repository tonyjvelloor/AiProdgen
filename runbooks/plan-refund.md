# Refunding a plan purchase (manual, V1)

Agency Reseller V2 spec, D4. The `payment.refunded` webhook (`api/webhooks/razorpay.js`)
revokes a **standalone purchase** entitlement automatically, by matching
`reference_id` to the payment ID. It cannot do the same for a **plan**
purchase (`hobbyist_ltd`, `agency_ltd`, ...): a plan-sourced entitlement's
`reference_id` gets overwritten to the plan ID every time `seedPlanEntitlements()`
runs, not kept as the payment ID, so there is nothing for the webhook to match.

Automating this safely needs more than the webhook has today (it would need
to know what plan the user should fall back to, and guard against reversing
a partial refund) -- not worth building before a real refund happens. Until
then, refund a plan purchase manually:

1. **Find the payment.** In the Supabase SQL editor:
   ```sql
   select * from payments where razorpay_payment_id = '<payment id>';
   ```
   Confirms `user_id`, `plan_id`, and `amount` — check this against what
   Razorpay's dashboard says was actually refunded before touching anything.

2. **Issue the refund in Razorpay first**, if you haven't already (this
   runbook is about reconciling AIProdGen's state *after* the money moves,
   not about issuing the refund itself).

3. **Step the account down.** From the project root, with `.env` configured:
   ```js
   node -e "
   require('dotenv').config();
   const db = require('./database');
   (async () => {
     await db.setUserPlan('<user_id>', 'free_explorer', 'monthly');
     const entitlements = require('./lib/entitlements');
     await entitlements.seedPlanEntitlements('<user_id>', 'free_explorer', {});
     console.log('done');
   })();
   "
   ```
   `seedPlanEntitlements(..., {})` with an empty config revokes every
   plan-sourced feature the account had (nothing in an empty config is
   "wanted"), without touching anything purchased separately (§06 of the
   spec — a standalone purchase survives a plan change by design).

4. **Leave the credit ledger alone.** The starter-credit allotment
   (`db.addCredits` at activation) is not reversed — treat it the same way a
   partially-used consumable would be in any refund: not worth clawing back
   for the volumes this is expected to see in V1.

5. **Note it somewhere you'll see it** (this file's git history is fine for
   now) — who, when, why. If refunds start happening often enough that this
   step feels like a burden, that's the signal to build the automated path,
   not before.
