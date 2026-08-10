// api/webhooks/razorpay.js
const crypto = require('crypto');
const { supabaseAdmin } = require('../../lib/supabase');



async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const signature = req.headers['x-razorpay-signature'];
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || 'test_secret')
    .update(rawBody)
    .digest('hex');

  if (signature !== expected) return res.status(400).send('Invalid signature');

  const event = JSON.parse(rawBody.toString());

  if (event.event === 'payment.captured') {
    const payment = event.payload.payment.entity;
    const { user_id, product_id } = payment.notes;

    const { error } = await supabaseAdmin.from('user_entitlements').upsert(
      { user_id, product_id, razorpay_payment_id: payment.id },
      { onConflict: 'user_id,product_id', ignoreDuplicates: true }
    );

    if (error) {
      console.error('Entitlement grant failed:', error);
      // Still return 200 so Razorpay doesn't retry endlessly on a DB hiccup —
      // log this for manual reconciliation instead.
    }
  }

  res.status(200).send('ok');
}
module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
