# Pre-sales release checklist

The October 29 audit fixes are local. Do not treat a passing unit suite as a production checkout or AI-quality test.

## Before release

- [ ] Revoke the GitHub personal access token that was in the local remote URL. The remote should use the plain HTTPS repository URL and a credential helper.
- [ ] Review the local diff and deploy first to staging. Install with `npm ci` to use the patched lockfile.
- [ ] Use `npm test` for safe default tests. These ignore `.env` and production credentials.
- [ ] Configure a separate staging Supabase project, provider keys and Razorpay test mode. Supply `TEST_SUPABASE_URL`, `TEST_SUPABASE_SERVICE_ROLE_KEY`, `TEST_JWT_SECRET` and other `TEST_` credentials before `npm run test:integration`. Database integration suites create and remove test data; never point these at production.
- [ ] Check production `APP_URL`, verification/reset sender, Upstash, provider configuration, JWT and the existing encryption secret. Never casually rotate KEY_ENCRYPTION_SECRET: old customer API keys depend on it.
- [ ] Set a genuine `RAZORPAY_WEBHOOK_SECRET` and configure `/api/webhooks/razorpay` for captured payments and refunds. Local configuration had a placeholder; live health showed the variable absent.
- [ ] Implement/test plan and acquisition reconciliation when the browser closes after payment. The webhook currently expects notes.user_id; the plan/acquisition order creators do not provide a complete matching fulfillment contract. Configuring a secret alone does not repair this.
- [ ] Test partial-failure recovery during plan activation: pending orders are consumed before all writes complete. Payment, plan, starter credits and entitlements need durable idempotent fulfillment/reconciliation.
- [ ] Run `node scripts/backfill_commercial_license.js` to review the paid-account count; apply with `--apply` only after checking the intended database. This adds the commercial right already promised to buyers.

## Acceptance evidence

- [ ] Fresh email signup sends one valid public verification link. Existing session works after verification, including resend and expired-link behavior.
- [ ] Google sign-in has a configured client and succeeds without requiring redundant email verification.
- [ ] Save, replace and remove a Gemini key. Removal must remove the server-side key, not only the browser marker.
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
