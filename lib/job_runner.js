const OutputService = require('./output_service');
const ImageService = require('./image_service');
const CopyService = require('./copy_service');
const db = require('../database');

class JobRunner {
    /**
     * Start processing a production job asynchronously.
     */
    static async processJob(userId, productId, collectionId, shots, options) {
        const totalOutputs = shots.filter(s => s.type === 'image').length; // For now, only images cost outputs
        
        // 1. Create AI Run record
        const runId = await db.createAIRun(userId, productId, collectionId, options.packType || 'job', 0, totalOutputs);
        
        // 2. Reserve Credits
        const reserved = await db.reserveCredits(userId, totalOutputs, runId);
        if (!reserved) {
            await db.updateAIRun(runId, { status: 'failed', error: 'Insufficient credits for reservation' });
            await OutputService.updateCollectionStatus(collectionId, 'failed');
            return;
        }

        // Run asynchronously without awaiting in the main request thread
        setImmediate(async () => {
            try {
                // 3. Mark as running
                await OutputService.updateCollectionStatus(collectionId, 'running');

                let outputsUsed = 0;
                
                // 4. Process each shot
                for (let i = 0; i < shots.length; i++) {
                    const shot = shots[i];
                    
                    console.log(`[JobRunner] Processing task ${i+1}/${shots.length}: ${shot.name} (${shot.type || 'image'})`);
                    
                    if (shot.type === 'copy' || shot.type === 'blueprint') {
                        // EXECUTOR: CopyService
                        const result = await CopyService.generate({
                            goal: shot.name,
                            style: shot.promptModifiers,
                            productContext: options.productContext
                        });

                        if (result && result.success) {
                            await OutputService.createOutput(productId, collectionId, {
                                type: shot.type === 'blueprint' ? 'blueprint_json' : 'copy',
                                engine: shot.type === 'blueprint' ? 'campaign_blueprint' : 'commerce', // generalize this later
                                format: shot.name,
                                status: 'published',
                                version: options.packVersion || 1,
                                metadata: {
                                    template: shot.template,
                                    content: result.text
                                }
                            });
                        }
                    } else {
                        // EXECUTOR: ImageService
                        const prompt = `${options.basePrompt}. ${shot.promptModifiers}`;
                        const generationOptions = {
                            goal: `Produce ${shot.name} shot`,
                            category: options.category || 'Product',
                            style: prompt,
                            aspectRatio: options.aspectRatio || '1:1',
                            presetVersion: '1.0'
                        };

                        // Pass runId to ImageService to link GenerationLogs
                        generationOptions.ai_run_id = runId;
                        generationOptions.productId = productId;
                        generationOptions.collectionId = collectionId;

                        const result = await ImageService.generate(userId, options.inputImageId, generationOptions);

                        if (result && result.success) {
                            outputsUsed++;
                            await OutputService.createOutput(productId, collectionId, {
                                type: 'image',
                                engine: 'photography', // generalize later
                                format: shot.name,
                                status: 'published',
                                version: options.packVersion || 1,
                                metadata: {
                                    template: shot.template,
                                    settings: options
                                },
                                storage_path: result.url
                            });
                        } else {
                            throw new Error(`Failed to generate shot ${shot.name}`);
                        }
                    }
                }

                // 5. Commit Transaction on Full Success
                await db.commitCredits(userId, totalOutputs, runId);
                await db.updateAIRun(runId, { status: 'completed', outputs_used: outputsUsed, completed_at: new Date().toISOString() });
                
                // 6. Mark collection as completed
                await OutputService.updateCollectionStatus(collectionId, 'completed');
                console.log(`[JobRunner] Collection ${collectionId} completed successfully.`);

            } catch (error) {
                console.error(`[JobRunner] Failed to process collection ${collectionId}:`, error);
                
                // Rollback Transaction on Partial/Full Failure
                await db.rollbackCredits(userId, totalOutputs, runId);
                await db.updateAIRun(runId, { status: 'rolled_back', error: error.message, completed_at: new Date().toISOString() });
                await OutputService.updateCollectionStatus(collectionId, 'failed');
            }
        });
    }
}

module.exports = JobRunner;
