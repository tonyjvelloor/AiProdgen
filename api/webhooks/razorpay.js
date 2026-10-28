// api/webhooks/razorpay.js
// Canonical, unified Razorpay Webhook handler for Express and Vercel Serverless
const crypto = require('crypto');
const entitlements = require('../../lib/entitlements');
const referrals = require('../../lib/referrals');
const db = require('../../database');

async function getRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Constant-time compare so a forged signature can't be recovered byte by byte from timing
function signatureMatches(signature, expected) {
  if (typeof signature !== 'string') return false;
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Fail closed. Falling back to a placeholder secret or KEY_SECRET would allow signature bypass.
  const PLACEHOLDER_SECRETS = new Set(['test_secret', 'your_webhook_secret', 'changeme']);
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!webhookSecret || PLACEHOLDER_SECRETS.has(webhookSecret.trim().toLowerCase())) {
    console.error(
      webhookSecret
        ? '[config] RAZORPAY_WEBHOOK_SECRET is set to a known placeholder — rejecting webhook.'
        : '[config] RAZORPAY_WEBHOOK_SECRET is not set — rejecting webhook.'
    );
    return res.status(503).json({ error: 'Webhook processing is not configured.' });
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers['x-razorpay-signature'];
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  if (!signatureMatches(signature, expected)) {
    console.error('[webhook] Invalid Razorpay webhook signature');
    return res.status(400).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch (err) {
    return res.status(400).send('Invalid JSON payload');
  }

  const { supabaseAdmin, isSupabaseConfigured } = require('../../lib/supabase');
  const payment = event.payload?.payment?.entity;
  // Use Razorpay's documented event identifier, header, or differentiate event types per payment
  const eventId = req.headers['x-razorpay-event-id'] || event.id || `${event.event}_${payment?.id || Date.now()}`;

  // Log incoming webhook event for audit trail
  if (isSupabaseConfigured) {
    const { error: insertErr } = await supabaseAdmin.from('webhook_events').insert({
      event_id: eventId,
      payload: event,
      processed: false
    });

    if (insertErr) {
      // If event was already logged, check if it was already fulfilled
      const { data: existingEvent } = await supabaseAdmin.from('webhook_events')
        .select('processed')
        .eq('event_id', eventId)
        .maybeSingle();

      if (existingEvent && existingEvent.processed) {
        console.log(`[webhook] Event ${eventId} already processed, returning 200`);
        return res.status(200).send('Already processed');
      }
    }
  }

  // 1. PAYMENT CAPTURED / ORDER PAID
  if (event.event === 'payment.captured' || event.event === 'order.paid') {
    if (!payment) {
      console.warn('[webhook] payment.captured missing payment entity');
      return res.status(200).send('Skipped: No payment entity');
    }

    const { getPlanConfig, planForOrder, isLifetimeOfferOrder } = require('../../lib/plans');
    const notes = payment.notes || {};
    let userId = notes.user_id || notes.userId;
    let email = notes.email || payment.email;
    const creditsToGrant = notes.credits ? parseInt(notes.credits, 10) : null;
    let planId = null;
    const featureOrProduct = notes.product_id || notes.feature;
    const quantity = notes.quantity ? parseInt(notes.quantity, 10) : null;

    // Resolve pending order if exists
    let pendingOrder = null;
    if (payment.order_id) {
      pendingOrder = await db.getPendingOrder(payment.order_id);
      if (pendingOrder) {
        email = email || pendingOrder.email;
        planId = planForOrder(pendingOrder);
      }
    }

    // Derive plan from payment amount if not set from pending order
    if (!planId) {
      planId = planForOrder({ amount: payment.amount, currency: payment.currency || 'USD' });
    }

    // Fall back to notes only if amount did not match
    if (!planId) {
      planId = notes.plan || (notes.type === 'plan_subscription' ? notes.plan : null);
    }

    // Check if this payment was already fulfilled
    if (isSupabaseConfigured) {
      const { data: existingPayment } = await supabaseAdmin
        .from('payments')
        .select('razorpay_payment_id, user_id, plan_id, status')
        .eq('razorpay_payment_id', payment.id)
        .maybeSingle();

      if (existingPayment && (existingPayment.status === 'fulfilled' || !existingPayment.status)) {
        console.log(`[webhook] payment ${payment.id} already fulfilled in ledger`);
        return res.status(200).send('Already processed');
      }
    }

    // Resolve user by email if not provided in notes
    if (!userId && email && isSupabaseConfigured) {
      const existingUser = await db.getUserByEmail(email);
      if (existingUser) {
        userId = existingUser.id;
      }
    }

    // Reconcile guest lifetime acquisition checkout if user not yet registered (browser closed after paying)
    if (!userId && email && (notes.type === 'acquisition_lifetime' || isLifetimeOfferOrder(pendingOrder))) {
      try {
        const auth = require('../../auth');
        const emailService = require('../../email');
        const credentials = await auth.registerUser(
          email,
          payment.id,
          payment.order_id,
          payment.amount,
          payment.currency || 'USD'
        );
        const newUser = await db.getUserByEmail(email);
        if (newUser) {
          userId = newUser.id;
          if (credentials?.password && typeof emailService.sendCredentialsEmail === 'function') {
            try {
              await emailService.sendCredentialsEmail(email, credentials.password);
            } catch (mailErr) {
              console.error('[webhook] sendCredentialsEmail failed (non-blocking):', mailErr.message);
            }
          }
        }
      } catch (regErr) {
        if (!regErr.message?.includes('already registered')) {
          console.error('[webhook] Failed to auto-register user on payment:', regErr.message);
          throw regErr;
        }
        const existing = await db.getUserByEmail(email);
        if (existing) userId = existing.id;
      }
    }

    if (!userId) {
      console.warn(`[webhook] payment ${payment.id} has no user_id and could not resolve user -- skipping grant`);
      return res.status(200).send('Skipped: No user data');
    }

    try {
      // 1. Fulfill Plan Subscriptions / Lifetime Deals (Browser closed after checkout)
      if (planId) {
        const planConfig = getPlanConfig(planId);
        await db.setUserPlan(userId, planId, 'lifetime');
        await db.initUserCredits(userId);
        if (planConfig.upscale > 0) {
          await db.addCredits(userId, planConfig.upscale, 'purchase', payment.id);
        }
        await entitlements.seedPlanEntitlements(userId, planId, planConfig)
          .catch(e => console.error('[webhook] seed entitlements error:', e.message));

        if (payment.order_id) {
          await db.deletePendingOrder(payment.order_id).catch(() => {});
        }

        await referrals.recordEligiblePayment({
          userId,
          paymentId: payment.id,
          orderId: payment.order_id,
          kind: 'plan',
          planId,
          grossAmountCents: payment.amount,
          currency: payment.currency || 'INR'
        }).catch(e => console.error('[webhook] commission recording failed:', e.message));

        console.log(`[webhook] Successfully fulfilled plan ${planId} for user ${userId} (${email})`);
      }

      // 2. Fulfill Credit Pack Grants if applicable
      if (creditsToGrant && creditsToGrant > 0) {
        let existingTx = null;
        if (isSupabaseConfigured) {
          const { data } = await supabaseAdmin.from('credit_transactions')
            .select('id')
            .eq('reference_id', payment.id)
            .eq('type', 'credit')
            .maybeSingle();
          existingTx = data;
        }

        if (!existingTx) {
          await db.recordCreditPurchase(
            userId,
            creditsToGrant,
            payment.amount,
            payment.id,
            payment.order_id
          );
        }
      }

      // 3. Fulfill standalone feature unlocks if applicable
      if (featureOrProduct) {
        await entitlements.grantEntitlement({
          userId,
          feature: featureOrProduct,
          quantity,
          source: entitlements.SOURCES.PURCHASE,
          referenceId: payment.id
        }).catch(e => console.error('[webhook] grant feature error:', e.message));
      }

      // 4. Record the financial payment record in ledger upon successful fulfillment
      await db.recordPayment({
        paymentId: payment.id,
        orderId: payment.order_id,
        userId,
        email,
        kind: planId ? 'plan' : (creditsToGrant ? 'credits' : (featureOrProduct ? 'feature' : 'unknown')),
        planId: planId || null,
        credits: creditsToGrant,
        amount: payment.amount,
        currency: payment.currency || 'INR',
        status: 'fulfilled'
      });

      // 3. Fulfill Credit Pack Grants if applicable
      if (creditsToGrant && creditsToGrant > 0) {
        const { data: existingTx } = await supabaseAdmin.from('credit_transactions')
          .select('id')
          .eq('reference_id', payment.id)
          .eq('type', 'credit')
          .maybeSingle();

        if (!existingTx) {
          await db.recordCreditPurchase(
            userId,
            creditsToGrant,
            payment.amount / 100,
            payment.id,
            payment.order_id
          );
          console.log(`[webhook] Successfully granted ${creditsToGrant} credits to user ${userId}`);
        }
      }

      // 4. Fulfill Entitlement / Feature Grants if applicable
      if (featureOrProduct && !planId) {
        await entitlements.grantEntitlement({
          userId: userId,
          feature: featureOrProduct,
          source: 'purchase',
          referenceId: payment.id,
          quantity: quantity
        });
        console.log(`[webhook] Successfully granted entitlement ${featureOrProduct} to user ${userId}`);
      }

      // 5. Mark webhook processed in audit ledger
      if (isSupabaseConfigured) {
        const { error: updateErr } = await supabaseAdmin.from('webhook_events')
          .update({ processed: true, processed_at: new Date().toISOString() })
          .eq('event_id', eventId);
        if (updateErr) {
          console.error('[webhook] Failed to mark webhook_event as processed:', updateErr.message);
          throw new Error(`Failed to update webhook event status: ${updateErr.message}`);
        }
      }
    } catch (grantErr) {
      console.error('[webhook] Critical failure granting purchase benefits:', grantErr.message);
      // Return 500 on transient database write error so Razorpay retries delivery
      return res.status(500).json({ error: 'Database error processing webhook. Retry scheduled.' });
    }
  }

  // 2. PAYMENT REFUNDED
  if (event.event === 'payment.refunded') {
    if (!payment) return res.status(200).send('Skipped: No payment entity');

    if (isSupabaseConfigured) {
      try {
        // A. Revoke Entitlement tied to this payment
        await entitlements.revokeEntitlementByReference(payment.id);

        // B. Reverse partner referral commissions if within clawback window
        const { reversed, needsClawback } = await referrals.reverseCommissionsForPayment(payment.id);
        if (reversed || needsClawback) {
          console.log(`[webhook] payment ${payment.id} refunded: ${reversed} commission(s) reversed, ${needsClawback} need manual clawback.`);
        }

        // C. Reverse Credit-Pack purchases tied to this refunded payment
        const creditReversal = await db.reverseCreditPurchase(payment.id);
        if (creditReversal.reversed && !creditReversal.alreadyReversed) {
          console.log(`[webhook] payment ${payment.id} refunded: ${creditReversal.creditsReversed} credits reversed from user balance.`);
        }

        const { error: updateErr } = await supabaseAdmin.from('webhook_events')
          .update({ processed: true, processed_at: new Date().toISOString() })
          .eq('event_id', eventId);
        if (updateErr) {
          console.error('[webhook] Failed to mark refund webhook_event as processed:', updateErr.message);
          throw new Error(`Failed to update refund webhook event status: ${updateErr.message}`);
        }
      } catch (refundErr) {
        console.error('[webhook] Critical failure processing refund:', refundErr.message);
        return res.status(500).json({ error: 'Database error processing refund.' });
      }
    }
  }

  return res.status(200).send('OK');
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
