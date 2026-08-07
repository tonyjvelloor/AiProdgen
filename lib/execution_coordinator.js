const db = require('../database');
const OutputService = require('./output_service');
const ProviderGateway = require('./provider_gateway');
const CleanupService = require('./cleanup_service');

class ExecutionCoordinator {
    /**
     * Orchestrates the full lifecycle of an AI job.
     */
    static async processJob(context, estimatedCosts, shots, options) {
        const { userId, productId, collectionId, jobType, req } = context;
        const requestId = req ? req.id : 'unknown'; // assuming req.id is generated early
        let aiRunId = null;
        let authId = null;
        const generatedUrls = [];

        try {
            // 1. Create AI Run
            aiRunId = await db.createAIRun(
                userId, productId, collectionId, jobType, estimatedCosts.totalCost, estimatedCosts.outputs
            );

            // 2. Output Authorization (Reserve Credits)
            const reserved = await db.reserveCredits(userId, estimatedCosts.outputs, aiRunId);
            if (!reserved) {
                throw new Error("Insufficient outputs available for reservation.");
            }

            authId = await db.createOutputAuthorization(
                userId, aiRunId, estimatedCosts.outputs, new Date(Date.now() + 60*60*1000).toISOString()
            );

            // Mark collection as running
            await OutputService.updateCollectionStatus(collectionId, 'running');

            let outputsUsed = 0;
            
            // 3. Provider Calls (Execution)
            for (let i = 0; i < shots.length; i++) {
                const shot = shots[i];
                console.log(`[ExecutionCoordinator] Processing task ${i+1}/${shots.length}: ${shot.name}`);
                
                const execContext = { aiRunId, requestId, provider: shot.type === 'copy' || shot.type === 'blueprint' ? 'gemini' : 'replicate', model: 'flux-dev' };
                
                if (shot.type === 'copy' || shot.type === 'blueprint') {
                    // COPY
                    execContext.model = 'gemini-2.5-pro';
                    const result = await ProviderGateway.callCopyProvider(execContext, {
                        goal: shot.name,
                        style: shot.promptModifiers,
                        productContext: options.productContext
                    });

                    if (result && result.success) {
                        await OutputService.createOutput(productId, collectionId, {
                            type: shot.type === 'blueprint' ? 'blueprint_json' : 'copy',
                            engine: shot.type === 'blueprint' ? 'campaign_blueprint' : 'commerce',
                            format: shot.name,
                            status: 'published',
                            version: options.packVersion || 1,
                            metadata: { template: shot.template, content: result.text }
                        });
                    } else throw new Error(`Failed to generate copy shot ${shot.name}`);
                } else {
                    // IMAGE
                    const prompt = `${options.basePrompt}. ${shot.promptModifiers}`;
                    const generationOptions = {
                        goal: `Produce ${shot.name} shot`,
                        category: options.category || 'Product',
                        style: prompt,
                        aspectRatio: options.aspectRatio || '1:1',
                        presetVersion: '1.0',
                        ai_run_id: aiRunId, // for ImageService legacy compat
                        productId,
                        collectionId
                    };

                    const result = await ProviderGateway.callImageProvider(execContext, userId, options.inputImageId, generationOptions);
                    
                    if (result && result.success) {
                        outputsUsed++;
                        generatedUrls.push(result.url); // Track for cleanup
                        await OutputService.createOutput(productId, collectionId, {
                            type: 'image',
                            engine: 'photography', 
                            format: shot.name,
                            status: 'published',
                            version: options.packVersion || 1,
                            metadata: { template: shot.template, settings: options },
                            storage_path: result.url
                        });
                    } else throw new Error(`Failed to generate image shot ${shot.name}`);
                }
            }

            // 4. Capture Outputs & Commit
            await db.commitCredits(userId, estimatedCosts.outputs, aiRunId);
            if (authId) await db.updateOutputAuthorizationStatus(authId, 'captured');
            
            // Mock margin (revenue - costs)
            const revenue = estimatedCosts.outputs * 0.10; // Assume 1 output = $0.10 retail
            const cogs = estimatedCosts.providerCost + estimatedCosts.storageCost + estimatedCosts.platformCost;
            const estimatedMargin = revenue > 0 ? ((revenue - cogs) / revenue) * 100 : 0;

            await db.updateAIRun(aiRunId, { 
                status: 'completed', 
                outputs_used: outputsUsed, 
                completed_at: new Date().toISOString(),
                request_id: requestId,
                provider_cost: estimatedCosts.providerCost,
                storage_cost: estimatedCosts.storageCost,
                platform_cost: estimatedCosts.platformCost,
                estimated_margin: estimatedMargin
            });
            
            await OutputService.updateCollectionStatus(collectionId, 'completed');
            console.log(`[ExecutionCoordinator] AI Run ${aiRunId} completed successfully.`);

        } catch (error) {
            console.error(`[ExecutionCoordinator] Workflow failed for AI Run ${aiRunId}:`, error);
            
            // 5. Failure Rollback & Cleanup
            if (aiRunId) {
                // Refund
                await db.rollbackCredits(userId, estimatedCosts.outputs, aiRunId);
                await db.updateAIRun(aiRunId, { status: 'failed', error_message: error.message, completed_at: new Date().toISOString() });
            }
            if (authId) {
                await db.updateOutputAuthorizationStatus(authId, 'released');
            }
            
            await OutputService.updateCollectionStatus(collectionId, 'failed');

            // Cleanup orphaned storage
            if (generatedUrls.length > 0) {
                await CleanupService.cleanupOrphanedStorage(generatedUrls);
            }
        }
    }
}

module.exports = ExecutionCoordinator;
