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

    const notes = payment.notes || {};
    const userId = notes.user_id || notes.userId;
    const creditsToGrant = notes.credits ? parseInt(notes.credits, 10) : null;
    const featureOrProduct = notes.product_id || notes.feature || notes.plan;
    const quantity = notes.quantity ? parseInt(notes.quantity, 10) : null;

    if (!userId) {
      console.warn(`[webhook] payment ${payment.id} has no user_id in notes -- nothing to grant`);
      return res.status(200).send('Skipped: No user data');
    }

    try {
      // A. Credit Pack Grants
      if (creditsToGrant && creditsToGrant > 0) {
        const { data: existingTx } = await supabaseAdmin.from('credit_transactions')
          .select('id')
          .eq('reference_id', payment.id)
          .maybeSingle();

        if (!existingTx) {
          await db.recordCreditPurchase(
            userId,
            creditsToGrant,
            payment.amount / 100,
            payment.id,
            payment.order_id
          );
          await db.recordPayment({
            paymentId: payment.id,
            orderId: payment.order_id,
            userId,
            kind: 'credits',
            credits: creditsToGrant,
            amount: payment.amount,
            currency: payment.currency || 'INR'
          });
          console.log(`[webhook] Successfully granted ${creditsToGrant} credits to user ${userId}`);
        }
      }

      // B. Entitlement / Feature Grants
      if (featureOrProduct) {
        await entitlements.grantEntitlement({
          userId: userId,
          feature: featureOrProduct,
          source: 'purchase',
          referenceId: payment.id,
          quantity: quantity
        });
        console.log(`[webhook] Successfully granted entitlement ${featureOrProduct} to user ${userId}`);
      }

      // Mark webhook processed in audit ledger
      if (isSupabaseConfigured) {
        try {
          await supabaseAdmin.from('webhook_events')
            .update({ processed: true, processed_at: new Date().toISOString() })
            .eq('event_id', eventId);
        } catch (e) {}
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

        await supabaseAdmin.from('webhook_events')
          .update({ processed: true, processed_at: new Date().toISOString() })
          .eq('event_id', eventId);
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
