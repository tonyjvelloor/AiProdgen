const db = require('../database');

class PolicyEngine {
    /**
     * Evaluates if a request is allowed to proceed.
     * Pure validation, no database writes.
     * 
     * @param {Object} context - { userId, workspaceId, jobType, req (express request) }
     * @param {Object} estimatedCosts - { outputs, providerCost }
     * @returns {Object} { allowed: boolean, reasons: string[] }
     */
    static async evaluateRequest(context, estimatedCosts) {
        const reasons = [];
        
        try {
            // 1. JWT / Auth Validation
            if (!context.userId) {
                reasons.push("Authentication required.");
                return { allowed: false, reasons };
            }

            const user = await db.getUserById(context.userId);
            if (!user) {
                reasons.push("User not found.");
                return { allowed: false, reasons };
            }

            // 2. Email Verified
            if (!user.email_verified_at) {
                reasons.push("Email verification required.");
            }

            // 3. Workspace Active (Mock check for now)
            // if (workspace.status !== 'active') reasons.push("Workspace is inactive.");

            // 4. Outputs Available
            const availableCredits = await db.getUserCredits(context.userId);
            if (availableCredits < estimatedCosts.outputs) {
                reasons.push(`Insufficient outputs. Required: ${estimatedCosts.outputs}, Available: ${availableCredits}`);
            }

            // 5. Platform spend ceiling
            // A backstop independent of credits and plan limits: however the
            // pricing is wrong, one account cannot cost more than this in a
            // rolling window. Credits gate what the user paid for; this gates
            // what the platform can lose.
            const ceiling = Number(process.env.PLATFORM_SPEND_CEILING_USD || 25);
            if (ceiling > 0) {
                const spent = await db.getUserPlatformSpend(context.userId, 30);
                const projected = spent + (estimatedCosts.providerCost || 0)
                    + (estimatedCosts.storageCost || 0) + (estimatedCosts.platformCost || 0);
                if (projected > ceiling) {
                    reasons.push(
                        `Platform spend ceiling reached ($${projected.toFixed(2)} of $${ceiling.toFixed(2)} in 30 days). ` +
                        `Add your own provider API key in Settings to continue.`
                    );
                }
            }

            // 6. Provider Availability
            // Requires checking provider_registry based on jobType.
            // Let's assume photography uses Replicate, copy uses Gemini
            let provider = 'replicate';
            if (context.jobType === 'copy' || context.jobType === 'blueprint') provider = 'gemini';
            
            const providerStatus = await db.getProviderHealth(provider);
            if (providerStatus !== 'healthy') {
                reasons.push(`Provider '${provider}' is currently unavailable.`);
            }

            return {
                allowed: reasons.length === 0,
                reasons
            };
        } catch (error) {
            console.error("[PolicyEngine] Evaluation error:", error);
            reasons.push("Internal policy evaluation error.");
            return { allowed: false, reasons };
        }
    }
}

module.exports = PolicyEngine;
