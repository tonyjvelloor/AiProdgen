// database.js (Supabase Adapter)
const { supabaseAdmin, isSupabaseConfigured } = require('./lib/supabase');

// Shapes a users row for the Express app. Every field here is read from the
// database -- an earlier version substituted a hardcoded bcrypt hash because
// the users table had no password_hash column, which made login impossible for
// every account. migrations/001_production_readiness.sql adds the columns.
function mapUser(sbUser) {
    if (!sbUser) return null;
    return {
        id: sbUser.id,
        email: sbUser.email,
        password_hash: sbUser.password_hash || null,
        is_active: sbUser.is_active === false ? 0 : 1,
        is_admin: sbUser.is_admin === true,
        plan: sbUser.plan || 'free_explorer',
        billing_cycle: sbUser.billing_cycle || null,
        monthly_gen_count: sbUser.monthly_gen_count || 0,
        monthly_ugc_count: sbUser.monthly_ugc_count || 0,
        usage_period_start: sbUser.usage_period_start || null,
        email_verified_at: sbUser.email_verified_at,
        created_at: sbUser.created_at
    };
}

// Usage counters are monthly. Rather than a scheduled job, the period is rolled
// forward lazily the first time a user is read in a new month.
function currentPeriodStart() {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

async function rollUsagePeriodIfStale(row) {
    if (!row) return row;
    const period = currentPeriodStart();
    if (row.usage_period_start && row.usage_period_start >= period) return row;

    const { data } = await supabaseAdmin.from('users')
        .update({ monthly_gen_count: 0, monthly_ugc_count: 0, usage_period_start: period })
        .eq('id', row.id)
        .select()
        .single();
    return data || row;
}

module.exports = {
    // ============ User Functions ============
    getUserByEmail: async (email) => {
        const { data } = await supabaseAdmin.from('users').select('*').eq('email', email).single();
        return mapUser(await rollUsagePeriodIfStale(data));
    },
    getUserById: async (id) => {
        const { data } = await supabaseAdmin.from('users').select('*').eq('id', id).single();
        return mapUser(await rollUsagePeriodIfStale(data));
    },
    createUser: async (email, passwordHash, paymentId, orderId, amountPaid = 0, currency = 'USD') => {
        // passwordHash was previously accepted and thrown away, leaving every
        // account with no credential on file.
        const { data, error } = await supabaseAdmin.from('users')
            .insert({ email, password_hash: passwordHash })
            .select()
            .single();
        if (error) throw new Error(`createUser failed: ${error.message}`);
        return mapUser(data);
    },
    emailExists: async (email) => {
        const { data } = await supabaseAdmin.from('users').select('id').eq('email', email).single();
        return !!data;
    },
    updateUser: async (id, updates) => {
        // Only columns the admin surface is allowed to touch.
        const allowed = ['email', 'password_hash', 'is_active', 'is_admin', 'plan', 'billing_cycle'];
        const patch = Object.fromEntries(Object.entries(updates || {}).filter(([k]) => allowed.includes(k)));
        if (!Object.keys(patch).length) return false;
        const { error } = await supabaseAdmin.from('users').update(patch).eq('id', id);
        return !error;
    },
    deleteUser: async (id) => {
        const { error } = await supabaseAdmin.from('users').delete().eq('id', id);
        return !error;
    },
    updatePassword: async (email, newPasswordHash) => { 
        const { data } = await supabaseAdmin.from('users').update({ password_hash: newPasswordHash }).eq('email', email).select().single();
        return !!data;
    },

    // ============ Plan / Entitlement Functions ============
    getUserPlan: async (userId) => {
        const { data } = await supabaseAdmin.from('users')
            .select('id, plan, billing_cycle, monthly_gen_count, monthly_ugc_count, usage_period_start')
            .eq('id', userId)
            .single();
        const row = await rollUsagePeriodIfStale(data);
        return {
            plan: row?.plan || 'free_explorer',
            billing_cycle: row?.billing_cycle || null,
            monthly_gen_count: row?.monthly_gen_count || 0,
            monthly_ugc_count: row?.monthly_ugc_count || 0
        };
    },
    setUserPlan: async (userId, plan, billingCycle = 'monthly') => {
        // This was a no-op returning true, so a verified Razorpay payment logged
        // "plan activated" and left the user on free.
        const { error } = await supabaseAdmin.from('users')
            .update({ plan, billing_cycle: billingCycle, plan_activated_at: new Date().toISOString() })
            .eq('id', userId);
        if (error) throw new Error(`setUserPlan failed: ${error.message}`);
        return true;
    },
    incrementGenCount: async (userId) => {
        const { data } = await supabaseAdmin.from('users').select('monthly_gen_count').eq('id', userId).single();
        const { error } = await supabaseAdmin.from('users')
            .update({ monthly_gen_count: (data?.monthly_gen_count || 0) + 1 })
            .eq('id', userId);
        return !error;
    },
    incrementUGCCount: async (userId) => {
        const { data } = await supabaseAdmin.from('users').select('monthly_ugc_count').eq('id', userId).single();
        const { error } = await supabaseAdmin.from('users')
            .update({ monthly_ugc_count: (data?.monthly_ugc_count || 0) + 1 })
            .eq('id', userId);
        return !error;
    },

    // ============ Credit Functions (Accounting Ledger) ============
    getUserCredits: async (userId) => {
        // SaaS Completeness: Use true accounting SUM(amount) and propagate database errors explicitly
        const { data, error } = await supabaseAdmin.from('credit_transactions')
            .select('amount')
            .eq('user_id', userId)
            .limit(100000);
        
        if (error) {
            console.error('Failed to fetch user credits:', error);
            throw new Error(`getUserCredits failed: ${error.message}`);
        }
        
        if (!data || data.length === 0) return 0;
        return data.reduce((sum, tx) => sum + tx.amount, 0);
    },
    getUserCreditInfo: async (userId) => {
        const { data, error } = await supabaseAdmin.from('credit_transactions')
            .select('amount')
            .eq('user_id', userId)
            .limit(100000);
        
        if (error) {
            console.error('Failed to fetch user credit info:', error);
            throw new Error(`getUserCreditInfo failed: ${error.message}`);
        }
        
        const rows = data || [];
        return {
            credits: rows.reduce((sum, tx) => sum + tx.amount, 0),
            total_purchased: rows.filter((t) => t.amount > 0).reduce((sum, t) => sum + t.amount, 0),
            total_used: Math.abs(rows.filter((t) => t.amount < 0).reduce((sum, t) => sum + t.amount, 0))
        };
    },
    initUserCredits: async (userId) => { 
        return await module.exports.addCredits(userId, 10, 'bonus', 'signup'); 
    },
    addCredits: async (userId, credits, referenceType = 'purchase', referenceId = null) => {
        const { error } = await supabaseAdmin.from('credit_transactions').insert({
            user_id: userId,
            type: 'credit',
            amount: credits,
            balance_after: 0, // running balance is derived by SUM(amount)
            source: referenceType,
            reference_id: referenceId
        });
        if (error) throw new Error(`addCredits failed: ${error.message}`);
        return await module.exports.getUserCredits(userId);
    },
    useCredits: async (userId, creditsToUse = 1, referenceType = 'generation', referenceId = null) => {
        // Deprecated standard useCredits for workflows. Left here for backward compat.
        const currentBalance = await module.exports.getUserCredits(userId);
        if (currentBalance < creditsToUse) return false;
        
        const { error } = await supabaseAdmin.from('credit_transactions').insert({
            user_id: userId,
            type: 'debit',
            amount: -creditsToUse,
            balance_after: currentBalance - creditsToUse,
            source: referenceType,
            reference_id: referenceId
        });
        if (error) throw new Error(`useCredits failed: ${error.message}`);
        return true;
    },
    // SaaS Completeness: Transaction Boundaries with Idempotency & Concurrency Safety
    reserveCredits: async (userId, amount, referenceId = null) => {
        if (!userId || amount <= 0) return false;

        // 1. Mandatory Atomic PostgreSQL RPC function (with row lock & unique index)
        if (isSupabaseConfigured) {
            const { data, error } = await supabaseAdmin.rpc('reserve_credits', {
                p_user_id: userId,
                p_amount: amount,
                p_reference_id: referenceId
            });

            if (error) {
                // In production, we FAIL CLOSED immediately on RPC errors.
                // A non-atomic fallback is strictly prohibited in production and only
                // allowed in local development/test environments when migration 008 is pending.
                const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
                const allowFallback = !isProduction && (
                    process.env.ALLOW_UNSAFE_CREDIT_FALLBACK === 'true' ||
                    process.env.NODE_ENV === 'test' ||
                    error.code === 'PGRST202'
                );

                if (!allowFallback) {
                    console.error(`[credits] reserve_credits RPC failed: ${error.message} (code: ${error.code})`);
                    throw new Error(`reserveCredits failed: atomic reservation RPC unavailable (${error.message})`);
                }
                console.warn(`[credits] Warning: reserve_credits RPC missing (${error.message}). Using test fallback.`);
            } else if (typeof data === 'boolean') {
                return data;
            }
        } else {
            if (process.env.NODE_ENV === 'production') {
                throw new Error('reserveCredits failed: Supabase is not configured in production environment.');
            }
        }

        // 2. Application-layer fallback logic (development & offline testing only)
        if (referenceId) {
            const { data: existing } = await supabaseAdmin.from('credit_transactions')
                .select('id')
                .eq('user_id', userId)
                .eq('reference_id', referenceId)
                .eq('type', 'reservation')
                .maybeSingle();
            if (existing) return true;
        }

        const currentBalance = await module.exports.getUserCredits(userId);
        if (currentBalance < amount) return false;
        
        // Deduct as 'reservation'
        const { error } = await supabaseAdmin.from('credit_transactions').insert({
            user_id: userId,
            type: 'reservation',
            amount: -amount,
            balance_after: currentBalance - amount,
            source: 'reserve',
            reference_id: referenceId
        });
        if (error) {
            // If unique constraint violation (code 23505), treat as idempotent success
            if (error.code === '23505') return true;
            throw new Error(`reserveCredits failed: ${error.message}`);
        }
        return true;
    },
    commitCredits: async (userId, amount, referenceId) => {
        // We assume credits are already deducted by reserveCredits. We just update the transaction type if we want,
        // or add a log. For an append-only ledger, the reserve is sufficient if it succeeded.
        // We could log a 0 amount commit for audit trail:
        const { error } = await supabaseAdmin.from('credit_transactions').insert({
            user_id: userId,
            type: 'commit',
            amount: 0,
            balance_after: 0,
            source: 'commit',
            reference_id: referenceId
        });
        if (error) throw new Error(`commitCredits failed: ${error.message}`);
        return true;
    },
    rollbackCredits: async (userId, amount, referenceId) => {
        // Refund the reservation
        const { error } = await supabaseAdmin.from('credit_transactions').insert({
            user_id: userId,
            type: 'refund',
            amount: amount,
            balance_after: 0,
            source: 'rollback',
            reference_id: referenceId
        });
        if (error) throw new Error(`rollbackCredits failed: ${error.message}`);
        return true;
    },
    reverseCreditPurchase: async (paymentId) => {
        if (!paymentId) return { reversed: false };

        // 1. Check if there was a credit purchase for this paymentId
        const { data: originalPurchase, error: findError } = await supabaseAdmin
            .from('credit_transactions')
            .select('id, user_id, amount')
            .eq('reference_id', paymentId)
            .eq('type', 'credit')
            .maybeSingle();

        if (findError) {
            console.error('[credits] Failed to look up credit purchase for refund:', findError.message);
            throw new Error(`Failed to query credit transaction: ${findError.message}`);
        }

        if (!originalPurchase) {
            // Payment was not a credit pack (e.g. was a subscription or LTD plan)
            return { reversed: false, reason: 'not_a_credit_pack' };
        }

        // 2. Check if this refund has already been recorded (idempotency)
        const { data: existingRefund, error: refundCheckErr } = await supabaseAdmin
            .from('credit_transactions')
            .select('id')
            .eq('reference_id', paymentId)
            .eq('type', 'refund')
            .maybeSingle();

        if (existingRefund) {
            return { reversed: true, alreadyReversed: true };
        }

        // 3. Deduct the credited amount as a refund entry in the ledger
        const creditAmountToReverse = originalPurchase.amount; // e.g. 50
        const { error: insertRefundError } = await supabaseAdmin
            .from('credit_transactions')
            .insert({
                user_id: originalPurchase.user_id,
                type: 'refund',
                amount: -creditAmountToReverse, // Offsets the positive credit
                balance_after: 0,
                source: 'payment_refund',
                reference_id: paymentId
            });

        if (insertRefundError) {
            if (insertRefundError.code === '23505') return { reversed: true, alreadyReversed: true };
            console.error('[credits] Failed to record credit purchase reversal:', insertRefundError.message);
            throw new Error(`Failed to reverse credit purchase: ${insertRefundError.message}`);
        }

        console.log(`[credits] Successfully reversed ${creditAmountToReverse} credits for refunded payment ${paymentId}`);
        return { reversed: true, creditsReversed: creditAmountToReverse };
    },
    recordCreditPurchase: async (userId, credits, amount, payId, ordId) => {
        return await module.exports.addCredits(userId, credits, 'razorpay', payId);
    },
    logUpscaleUsage: async (userId, credits, scale, face) => {
        const { error } = await supabaseAdmin.from('upscale_usage')
            .insert({ user_id: userId, credits, scale, face_enhance: !!face });
        return !error;
    },
    getCreditPurchaseHistory: async (userId) => {
        const { data } = await supabaseAdmin.from('credit_transactions')
            .select('*')
            .eq('user_id', userId)
            .gt('amount', 0)
            .order('created_at', { ascending: false });
        return data || [];
    },
    getUpscaleUsageHistory: async (userId) => {
        const { data } = await supabaseAdmin.from('upscale_usage')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        return data || [];
    },

    // ============ Revenue ============
    // Every captured payment is written here so gross margin is computable.
    // Idempotent on razorpay_payment_id: the checkout callback and the webhook
    // can both report the same payment.
    recordPayment: async ({ paymentId, orderId, userId, email, kind, planId, credits, amount, currency = 'INR' }) => {
        if (!paymentId) return false;
        const { error } = await supabaseAdmin.from('payments').upsert({
            razorpay_payment_id: paymentId,
            razorpay_order_id: orderId || null,
            user_id: userId || null,
            email: email || null,
            kind,
            plan_id: planId || null,
            credits: credits || null,
            amount,
            currency
        }, { onConflict: 'razorpay_payment_id' });
        if (error) {
            console.error('recordPayment failed:', error.message);
            throw new Error(`recordPayment failed: ${error.message}`);
        }
        return true;
    },
    // Sum of what this user's runs have cost the platform in the trailing
    // window. Backs the spend ceiling in PolicyEngine, so a pricing mistake is
    // bounded instead of unbounded.
    // Status of the workspace a user owns. Returns null when there is no
    // workspace or the column is absent, which PolicyEngine treats as "do not
    // block" so an unapplied migration cannot lock everyone out.
    getWorkspaceStatus: async (userId) => {
        if (!userId) return null;
        const { data, error } = await supabaseAdmin.from('workspaces')
            .select('status')
            .eq('owner_id', userId)
            .maybeSingle();
        if (error || !data) return null;
        return data.status || null;
    },

    getUserPlatformSpend: async (userId, days = 30) => {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabaseAdmin.from('ai_runs')
            .select('provider_cost, storage_cost, platform_cost')
            .eq('user_id', userId)
            .gte('started_at', since);
        if (error) {
            console.error('getUserPlatformSpend failed:', error.message);
            return 0;
        }
        return (data || []).reduce((sum, r) =>
            sum + Number(r.provider_cost || 0) + Number(r.storage_cost || 0) + Number(r.platform_cost || 0), 0);
    },

    getRevenue: async (sinceIso = null) => {
        let q = supabaseAdmin.from('payments').select('amount, currency, kind, created_at').eq('status', 'captured');
        if (sinceIso) q = q.gte('created_at', sinceIso);
        const { data } = await q;
        return data || [];
    },

    // ============ Async Provider Jobs ============
    // Maps a provider-issued job id to the user who started it, so the polling
    // routes can refuse to serve someone else's result.
    recordAsyncJob: async (externalId, userId, provider, kind = null) => {
        if (!externalId || !userId) return false;
        const { error } = await supabaseAdmin.from('async_jobs')
            .upsert({ external_id: externalId, user_id: userId, provider, kind },
                    { onConflict: 'external_id' });
        if (error) console.error('recordAsyncJob failed:', error.message);
        return !error;
    },
    getAsyncJobOwner: async (externalId) => {
        const { data } = await supabaseAdmin.from('async_jobs')
            .select('user_id')
            .eq('external_id', externalId)
            .single();
        return data ? data.user_id : null;
    },

    // ============ AI Runs & Generation History ============
    createAIRun: async (userId, productId, collectionId, job, cost, outputsReserved) => {
        try {
            const { data } = await supabaseAdmin.from('ai_runs').insert({
                user_id: userId,
                product_id: productId,
                collection_id: collectionId,
                job: job,
                status: 'running',
                cost: cost,
                outputs_reserved: outputsReserved
            }).select('id').single();
            return data ? data.id : null;
        } catch(e) {
            console.error('Failed to create AI Run:', e.message);
            return null;
        }
    },
    updateAIRun: async (runId, updates) => {
        if (!runId) return;
        // This used to swallow every error silently. A missing column meant
        // cost was never written and nothing said so -- the same failure mode
        // that hid the credit ledger writing to a column that did not exist.
        const { error } = await supabaseAdmin.from('ai_runs').update(updates).eq('id', runId);
        if (error) console.error(`updateAIRun(${runId}) failed:`, error.message);
    },
    logGeneration: async (userId, provider, model, promptTokens, completionTokens, estimatedCost, creditsUsed, latency, status, errorMsg, presetVersion, category, aspectRatio, goal, inputImageId, outputImageIds, providerResponseId, runId, outputsUsed, engineVersion, collectionId, productId) => { 
        const { data } = await supabaseAdmin.from('generation_logs').insert({
            user_id: userId,
            provider,
            model,
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            estimated_cost: estimatedCost,
            credits_used: creditsUsed,
            latency_ms: latency,
            generation_duration: latency, 
            status,
            error_message: errorMsg,
            failure_reason: errorMsg, 
            preset_version: presetVersion,
            category,
            aspect_ratio: aspectRatio,
            goal,
            input_image_id: inputImageId,
            output_image_ids: outputImageIds,
            provider_response_id: providerResponseId,
            ai_run_id: runId,
            outputs_used: outputsUsed,
            engine_version: engineVersion,
            collection_id: collectionId,
            product_id: productId,
            job: goal
        }).select('id').single();
        return data ? data.id : null;
    },
    // ---- Provider Calls & Health ----
    createProviderCall: async (aiRunId, provider, model, requestId, estimatedCost) => {
        try {
            const { data } = await supabaseAdmin.from('provider_calls').insert({
                ai_run_id: aiRunId,
                provider: provider,
                model: model,
                request_id: requestId,
                cost: estimatedCost,
                status: 'started'
            }).select('id').single();
            return data ? data.id : null;
        } catch(e) { return null; }
    },
    updateProviderCall: async (callId, updates) => {
        if (!callId) return;
        try {
            await supabaseAdmin.from('provider_calls').update(updates).eq('id', callId);
        } catch(e) {}
    },
    getProviderHealth: async (provider) => {
        try {
            const { data } = await supabaseAdmin.from('provider_registry')
                .select('status')
                .eq('provider', provider)
                .single();
            return data ? data.status : 'healthy'; // fail open if registry misses
        } catch(e) {
            return 'healthy';
        }
    },
    // ---- Output Authorizations ----
    createOutputAuthorization: async (userId, runId, outputsReserved, expiresAt) => {
        try {
            const { data } = await supabaseAdmin.from('output_authorizations').insert({
                user_id: userId,
                ai_run_id: runId,
                outputs_reserved: outputsReserved,
                expires_at: expiresAt
            }).select('id').single();
            return data ? data.id : null;
        } catch(e) { return null; }
    },
    updateOutputAuthorizationStatus: async (authId, status) => {
        if (!authId) return;
        try {
            await supabaseAdmin.from('output_authorizations').update({ status }).eq('id', authId);
        } catch(e) {}
    },
    
    getGenerationHistory: async (userId, limit = 20) => {
        const { data } = await supabaseAdmin.from('generation_logs')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);
        return data || [];
    },
    getUserStats: async (userId) => { 
        const { count } = await supabaseAdmin.from('generation_logs').select('*', { count: 'exact', head: true }).eq('user_id', userId);
        return { total_generations: count || 0, total_images: count || 0, last_generation: null }; 
    },

    // ============ Admin ============
    getAdminStats: async () => {
        // Previously returned all zeros, so the CEO dashboard reported fiction.
        const [users, generations, runs, credits] = await Promise.all([
            supabaseAdmin.from('users').select('*', { count: 'exact', head: true }),
            supabaseAdmin.from('generations').select('*', { count: 'exact', head: true }),
            supabaseAdmin.from('ai_runs').select('provider_cost, storage_cost, platform_cost, status'),
            supabaseAdmin.from('credit_transactions').select('amount').gt('amount', 0)
        ]);

        const runRows = runs.data || [];
        const aiCost = runRows.reduce((sum, r) =>
            sum + Number(r.provider_cost || 0) + Number(r.storage_cost || 0) + Number(r.platform_cost || 0), 0);
        const creditsSold = (credits.data || []).reduce((sum, t) => sum + t.amount, 0);

        return {
            userCount: users.count || 0,
            totalGenerations: generations.count || 0,
            totalImages: generations.count || 0,
            campaignsProduced: runRows.filter((r) => r.status === 'completed').length,
            creditsSold,
            aiCost: Number(aiCost.toFixed(4)),
            revenue: 0 // populated from Razorpay settlements, not derivable here
        };
    },
    getAllUsers: async (limit = 50) => {
        const { data } = await supabaseAdmin.from('users').select('*').order('created_at', { ascending: false }).limit(limit);
        return (data || []).map(mapUser);
    },

    // ============ UGC / Pending Orders / Misc ============
    createPendingOrder: async (razorpayOrderId, email, amount, currency = 'INR') => {
        const { error } = await supabaseAdmin.from('pending_orders')
            .upsert({ razorpay_order_id: razorpayOrderId, email, amount, currency },
                    { onConflict: 'razorpay_order_id' });
        if (error) throw new Error(`createPendingOrder failed: ${error.message}`);
        return true;
    },
    getPendingOrder: async (razorpayOrderId) => {
        const { data } = await supabaseAdmin.from('pending_orders')
            .select('*')
            .eq('razorpay_order_id', razorpayOrderId)
            .single();
        return data || null;
    },
    deletePendingOrder: async (razorpayOrderId) => {
        const { error } = await supabaseAdmin.from('pending_orders')
            .delete()
            .eq('razorpay_order_id', razorpayOrderId);
        return !error;
    },
    // DELETE ... RETURNING under a row lock: of any number of concurrent or
    // replayed calls for the same order, exactly one gets the row back. That
    // is what makes a payment single-use.
    claimPendingOrder: async (razorpayOrderId, email) => {
        const { data, error } = await supabaseAdmin.from('pending_orders')
            .delete()
            .eq('razorpay_order_id', razorpayOrderId)
            .eq('email', email)
            .select();
        if (error) throw new Error(`claimPendingOrder failed: ${error.message}`);
        return (data && data[0]) || null;
    },
    createResetToken: async (email, tokenHash, expiresAt) => { 
        const user = await module.exports.getUserByEmail(email);
        if (!user) return false;
        await supabaseAdmin.from('auth_tokens').insert({
            user_id: user.id,
            token_hash: tokenHash,
            type: 'password_reset',
            expires_at: expiresAt
        });
        return true;
    },
    getValidResetToken: async (tokenHash) => { 
        const { data } = await supabaseAdmin.from('auth_tokens')
            .select('user_id, users(email)')
            .eq('token_hash', tokenHash)
            .eq('type', 'password_reset')
            .is('used_at', null)
            .gt('expires_at', new Date().toISOString())
            .maybeSingle();
        if (data) {
            return { email: data.users.email, user_id: data.user_id };
        }
        return null; 
    },
    markTokenUsed: async (tokenHash) => { 
        await supabaseAdmin.from('auth_tokens').update({ used_at: new Date().toISOString() }).eq('token_hash', tokenHash);
        return true; 
    },
    createVerificationToken: async (userId, tokenHash, expiresAt) => {
        await supabaseAdmin.from('auth_tokens').insert({
            user_id: userId,
            token_hash: tokenHash,
            type: 'email_verification',
            expires_at: expiresAt
        });
        return true;
    },
    verifyEmailToken: async (tokenHash) => {
        // Find valid token
        const { data } = await supabaseAdmin.from('auth_tokens')
            .select('user_id')
            .eq('token_hash', tokenHash)
            .eq('type', 'email_verification')
            .is('used_at', null)
            .gt('expires_at', new Date().toISOString())
            .maybeSingle();
            
        if (!data) return false;
        
        // Update user
        await supabaseAdmin.from('users').update({ email_verified_at: new Date().toISOString() }).eq('id', data.user_id);
        // Mark token used
        await module.exports.markTokenUsed(tokenHash);
        return true;
    },
    createUGCProject: async (userId, name, workflow, thumbnail) => {
        const { data, error } = await supabaseAdmin.from('ugc_projects')
            .insert({
                user_id: userId,
                name,
                workflow: typeof workflow === 'string' ? JSON.parse(workflow) : workflow,
                thumbnail
            })
            .select()
            .single();
        if (error) throw new Error(`createUGCProject failed: ${error.message}`);
        return data;
    },
    updateUGCProject: async (id, updates) => {
        const { error } = await supabaseAdmin.from('ugc_projects')
            .update({ ...updates, updated_at: new Date().toISOString() })
            .eq('id', id);
        return !error;
    },
    getUserProjects: async (userId) => {
        const { data } = await supabaseAdmin.from('ugc_projects')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        return data || [];
    },
    getProjectById: async (id) => {
        const { data } = await supabaseAdmin.from('ugc_projects').select('*').eq('id', id).single();
        return data || null;
    },
    addToGallery: async (userId, projectId, type, url, prompt) => {
        const { error } = await supabaseAdmin.from('gallery_items')
            .insert({ user_id: userId, project_id: projectId, type, url, prompt });
        return !error;
    },
    getPublicGallery: async (limit = 50) => {
        const { data } = await supabaseAdmin.from('gallery_items')
            .select('*')
            .eq('is_public', true)
            .order('created_at', { ascending: false })
            .limit(limit);
        return data || [];
    },
    getUserGallery: async (userId) => {
        const { data } = await supabaseAdmin.from('gallery_items')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
        return data || [];
    },
    toggleGalleryPublic: async (id, userId, isPublic) => {
        const { error } = await supabaseAdmin.from('gallery_items')
            .update({ is_public: isPublic })
            .eq('id', id)
            .eq('user_id', userId);
        return !error;
    }
};
