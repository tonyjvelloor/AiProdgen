// api/webhooks/razorpay.js
const crypto = require('crypto');
const entitlements = require('../../lib/entitlements');
const referrals = require('../../lib/referrals');



async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Constant-time compare so a forged signature can't be recovered byte by byte
// from response timing.
function signatureMatches(signature, expected) {
  if (typeof signature !== 'string') return false;
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Fail closed. Falling back to a placeholder secret would make every
  // signature check pass for anyone who read this file, letting a forged
  // payment.captured event grant paid entitlements for free.
  // 'test_secret' was this file's hardcoded fallback and is in the git history,
  // so treating it as a real secret would restore the bypass it caused. Reject
  // the known placeholders the same way as an unset variable.
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

  if (!signatureMatches(signature, expected)) return res.status(400).send('Invalid signature');

  const event = JSON.parse(rawBody.toString());

  // This originally upserted into `user_entitlements`, a table nothing ever
  // read from -- a feature-unlock purchase notified via webhook granted
  // nothing any route could check. It now grants through the same
  // entitlements module the synchronous purchase-verify routes use.
  // grantEntitlement's own dedupe (source='purchase' keyed by reference_id =
  // payment id) makes this safe against Razorpay's at-least-once delivery:
  // a retried payment.captured for the same payment grants nothing twice.
  if (event.event === 'payment.captured') {
    const payment = event.payload.payment.entity;
    const { user_id, product_id, quantity } = payment.notes || {};

    if (!user_id || !product_id) {
      console.error(`[webhook] payment.captured ${payment.id} has no user_id/product_id in notes -- nothing to grant`);
    } else {
      try {
        await entitlements.grantEntitlement({
          userId: user_id,
          feature: product_id,
          source: 'purchase',
          referenceId: payment.id,
          quantity: quantity ? parseInt(quantity, 10) : null
        });
      } catch (e) {
        console.error('[webhook] entitlement grant failed:', e.message);
        // Still return 200 so Razorpay doesn't retry endlessly on a DB
        // hiccup -- log this for manual reconciliation instead.
      }
    }
  }

  // Razorpay fires this on the original payment when it's refunded (in full
  // or in part). A refunded purchase must not leave the feature it bought
  // still unlocked -- revoking by payment id needs no trust in this event's
  // own notes, since reference_id was set to the payment id at grant time.
  if (event.event === 'payment.refunded') {
    const payment = event.payload.payment.entity;
    try {
      await entitlements.revokeEntitlementByReference(payment.id);
    } catch (e) {
      console.error('[webhook] entitlement revoke-on-refund failed:', e.message);
    }
    // Test 3/4 (Partner Program acceptance criteria): a refund before the
    // hold window clears reverses the commission; a refund after it's paid
    // is left alone and counted for manual clawback (see reverseCommissionsForPayment).
    try {
      const { reversed, needsClawback } = await referrals.reverseCommissionsForPayment(payment.id);
      if (reversed || needsClawback) {
        console.log(`[webhook] payment ${payment.id} refunded: ${reversed} commission(s) reversed, ${needsClawback} need manual clawback.`);
      }
    } catch (e) {
      console.error('[webhook] commission reversal failed:', e.message);
    }
  }

  res.status(200).send('ok');
}
module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
