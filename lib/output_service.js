// lib/output_service.js
const { supabaseAdmin } = require('./supabase');

/**
 * OutputService
 * Manages operations for Output Collections and Outputs.
 */
class OutputService {
    /**
     * Create an output collection for a product.
     * @param {string} productId 
     * @param {string} job 
     * @param {Object} metadata 
     * @returns {Promise<Object>} Output Collection object
     */
    static async createCollection(productId, job, metadata = {}) {
        const { data, error } = await supabaseAdmin
            .from('output_collections')
            .insert({
                product_id: productId,
                job: job,
                status: 'queued',
                metadata: metadata
            })
            .select()
            .single();

        if (error) {
            console.error('Error creating output collection:', error);
            throw new Error('Failed to create output collection');
        }

        return data;
    }

    /**
     * Update an output collection status.
     * @param {string} collectionId 
     * @param {string} status 
     */
    static async updateCollectionStatus(collectionId, status) {
        const { error } = await supabaseAdmin
            .from('output_collections')
            .update({ status: status })
            .eq('id', collectionId);

        if (error) {
            console.error('Error updating collection status:', error);
            throw new Error('Failed to update collection status');
        }
    }

    /**
     * Get a specific collection by ID (used for polling).
     * @param {string} collectionId 
     * @returns {Promise<Object>}
     */
    static async getCollection(collectionId) {
        const { data, error } = await supabaseAdmin
            .from('output_collections')
            .select('*, outputs(*)')
            .eq('id', collectionId)
            .single();

        if (error) {
            console.error('Error fetching collection:', error);
            throw new Error('Failed to fetch collection');
        }

        return data;
    }

    /**
     * Create a single output in a collection.
     * @param {string} productId 
     * @param {string} collectionId 
     * @param {Object} outputData 
     * @returns {Promise<Object>} Output object
     */
    static async createOutput(productId, collectionId, outputData) {
        const { data, error } = await supabaseAdmin
            .from('outputs')
            .insert([
                {
                    product_id: productId,
                    collection_id: collectionId,
                    type: outputData.type || 'image',
                    engine: outputData.engine,
                    format: outputData.format,
                    status: outputData.status || 'completed',
                    version: outputData.version || 1,
                    metadata: outputData.metadata || {},
                    storage_path: outputData.storage_path || null
                }
            ])
            .select()
            .single();

        if (error) {
            console.error('Error creating output:', error);
            throw new Error('Failed to create output');
        }

        return data;
    }

    /**
     * Get all outputs for a workspace (Content Library).
     * @param {string} workspaceId 
     * @returns {Promise<Array>} Array of Output objects
     */
    static async getWorkspaceOutputs(workspaceId) {
        // Needs a join through products
        const { data, error } = await supabaseAdmin
            .from('outputs')
            .select('*, products!inner(workspace_id, name)')
            .eq('products.workspace_id', workspaceId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching workspace outputs:', error);
            throw new Error('Failed to fetch workspace outputs');
        }

        return data;
    }

    /**
     * Get collections (timeline) for a product.
     * @param {string} productId 
     * @returns {Promise<Array>} Array of Collections with their nested Outputs
     */
    static async getProductTimeline(productId) {
        const { data, error } = await supabaseAdmin
            .from('output_collections')
            .select('*, outputs(*)')
            .eq('product_id', productId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching product timeline:', error);
            throw new Error('Failed to fetch product timeline');
        }

        return data;
    }
}

module.exports = OutputService;
