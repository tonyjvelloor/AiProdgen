const db = require('../database');
const ImageService = require('./image_service');
const CopyService = require('./copy_service');

class ProviderGateway {
    /**
     * Executes a provider call with exponential backoff and logging.
     * @param {Object} executionContext - { aiRunId, requestId, provider, model }
     * @param {Function} serviceFn - The underlying service function to execute
     * @param {Array} args - Arguments to pass to serviceFn
     */
    static async executeWithRetry(executionContext, serviceFn, args) {
        const { aiRunId, requestId, provider, model } = executionContext;
        let attempt = 0;
        const maxAttempts = 3;
        
        while (attempt < maxAttempts) {
            attempt++;
            const callId = await db.createProviderCall(aiRunId, provider, model, requestId, 0); // initial cost 0
            const startTime = Date.now();
            
            try {
                // Call the actual service (ImageService / CopyService)
                const result = await serviceFn(...args);
                
                const latencyMs = Date.now() - startTime;
                
                await db.updateProviderCall(callId, {
                    status: 'success',
                    latency_ms: latencyMs,
                    cost: result.cost || 0
                });
                
                return result; // Success!
            } catch (error) {
                const latencyMs = Date.now() - startTime;
                
                await db.updateProviderCall(callId, {
                    status: 'failed',
                    error_message: error.message,
                    latency_ms: latencyMs
                });

                // Determine if we should retry
                const errorMessage = error.message.toLowerCase();
                const isRetryable = 
                    errorMessage.includes('429') || 
                    errorMessage.includes('too many requests') ||
                    errorMessage.includes('500') ||
                    errorMessage.includes('502') ||
                    errorMessage.includes('503') ||
                    errorMessage.includes('timeout') ||
                    errorMessage.includes('econnreset') ||
                    errorMessage.includes('gateway timeout');

                if (!isRetryable || attempt >= maxAttempts) {
                    throw error; // Bubble up the error
                }

                // Exponential backoff
                const backoffMs = Math.pow(2, attempt) * 1000;
                console.log(`[ProviderGateway] ${provider} call failed (Attempt ${attempt}). Retrying in ${backoffMs}ms...`);
                await new Promise(res => setTimeout(res, backoffMs));
            }
        }
    }

    static async callImageProvider(executionContext, userId, inputImageId, options) {
        return await ProviderGateway.executeWithRetry(
            executionContext, 
            ImageService.generate, 
            [userId, inputImageId, options]
        );
    }

    static async callCopyProvider(executionContext, options) {
        return await ProviderGateway.executeWithRetry(
            executionContext,
            CopyService.generate,
            [options]
        );
    }
}

module.exports = ProviderGateway;
