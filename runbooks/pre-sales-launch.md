# Pre-sales release checklist

The October 29 audit and failure-injection remediations are committed. Regression coverage is enforced in `tests/payment-failure-recovery.test.js` and `tests/checkout-regression.test.js`.

## Before release

- [x] Revoke the GitHub personal access token that was in the local remote URL. Remote is verified clean HTTPS: `https://github.com/tonyjvelloor/AiProdgen.git`.
- [x] Review the local diff and deploy first to staging. Install with `npm ci` to use the patched lockfile.
- [x] Use `npm test` for safe default tests. Passing 233 tests across 57 suites in complete isolation from `.env` and production credentials.
- [ ] Configure a separate staging Supabase project, provider keys and Razorpay test mode. Supply `TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY`, `TEST_JWT_SECRET` and other `TEST_` credentials before `npm run test:integration`. Database integration suites create and remove test data; never point these at production.
- [ ] Check production `APP_URL`, verification/reset sender, Upstash, provider configuration, JWT and the existing encryption secret. Never casually rotate KEY_ENCRYPTION_SECRET: old customer API keys depend on it.
- [ ] Set a genuine `RAZORPAY_WEBHOOK_SECRET` and configure `/api/webhooks/razorpay` for captured payments and refunds. Webhook rejects placeholder secrets (`test_secret`, `changeme`).
- [x] Implement/test plan and acquisition reconciliation when the browser closes after payment. The webhook reconciles guest and upgrade checkouts, derives products from validated order amounts (ensuring $197 Agency does not downgrade to Hobbyist), and sends credentials using `email.js`. Covered in `tests/payment-failure-recovery.test.js`.
- [x] Test partial-failure recovery during plan activation: fixed `planConfig` scope, eliminated starter credit duplication on retry, and prevented webhook from acknowledging incomplete activations.
- [x] Run `node scripts/backfill_commercial_license.js` to review the paid-account count; apply with `--apply` only after checking the intended database. This adds the commercial right already promised to buyers.

## Acceptance evidence

- [ ] Fresh email signup sends one valid public verification link. Existing session works after verification, including resend and expired-link behavior.
- [ ] Google sign-in has a configured client and succeeds without requiring redundant email verification.
- [x] Save, replace and remove a Gemini key. Removal removes the server-side key in the database vault via `/api/keys/remove`, not only the browser marker.
- [ ] Upload JPEG, PNG and WebP under 3 MB; create a product; run photography, commerce, blueprint and production; poll and download the results.
- [ ] Two staging accounts cannot start jobs, set primary outputs or read job results across products/workspaces.
- [ ] Test $47, ₹3,999, $97 and $197 in Razorpay test mode; repeat callbacks, close the browser after paying and simulate a failed database write.
- [ ] Refund a plan and a credit pack, check ledger amounts and follow `runbooks/plan-refund.md` for plan access. Verify the effect on starter credits and referral commissions.
- [ ] Validate the existing two customers retain their paid plan and rights, without buying again.
- [ ] Test monthly BYOK limits across legacy generation and Studio packs. Concurrency contracts have local coverage; verify real PostgreSQL behavior in staging, including a month boundary.
- [ ] Test the largest supported pack under Vercel's function-duration limit. waitUntil retains execution but is not a durable queue; longer jobs need a worker/queue and recovery for interrupted runs.
- [ ] Evaluate at least 20 actual product inputs: labels, shape, colors, background, resolution, retries, time and cost per accepted export. Get buyer approval on deliverables.
- [ ] Review mobile signup, settings and checkout; publish only images with traceable input/output provenance and buyer-approved testimonials.
- [ ] Finish factual consistency across FAQ, about/features, privacy and plan cards. Legal policies and refund wording require owner review before publication.
- [ ] Configure production error reporting and measure signup -> key saved -> first accepted export -> purchase -> repeat use before paid acquisition.
