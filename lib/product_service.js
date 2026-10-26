// lib/product_service.js
const { supabaseAdmin } = require('./supabase');

/**
 * ProductService
 * Manages operations for Products.
 */
class ProductService {
    /**
     * Create a new product.
     * @param {string} workspaceId 
     * @param {Object} productData 
     * @returns {Promise<Object>} Product object
     */
    static async createProduct(workspaceId, productData) {
        const { data, error } = await supabaseAdmin
            .from('products')
            .insert({
                workspace_id: workspaceId,
                name: productData.name,
                category: productData.category || null,
                price: productData.price || null,
                usp: productData.usp || null,
                target_audience: productData.target_audience || null,
                brand: productData.brand || null,
                description: productData.description || null,
                status: 'draft'
            })
            .select()
            .single();

        if (error) {
            console.error('Error creating product:', error);
            throw new Error('Failed to create product');
        }

        return data;
    }

    /**
     * Update an existing product with strict mass-assignment protection.
     * @param {string} productId 
     * @param {Object} updateData 
     * @returns {Promise<Object>} Updated Product object
     */
    static async updateProduct(productId, updateData) {
        if (!updateData || typeof updateData !== 'object') {
            throw new Error('Invalid update data provided');
        }

        // Strict allowlist of user-editable fields
        const ALLOWED_FIELDS = [
            'name',
            'category',
            'price',
            'usp',
            'target_audience',
            'brand',
            'description',
            'status',
            'primary_output_id'
        ];

        // Explicitly reject tampering with immutable security fields
        if (updateData.workspace_id !== undefined || updateData.id !== undefined || updateData.created_at !== undefined) {
            const forbidden = [];
            if (updateData.workspace_id !== undefined) forbidden.push('workspace_id');
            if (updateData.id !== undefined) forbidden.push('id');
            if (updateData.created_at !== undefined) forbidden.push('created_at');
            throw new Error(`Cannot modify protected fields: ${forbidden.join(', ')}`);
        }

        const sanitized = {};
        for (const field of ALLOWED_FIELDS) {
            if (updateData[field] !== undefined) {
                sanitized[field] = updateData[field];
            }
        }

        if (sanitized.status !== undefined) {
            const VALID_STATUSES = ['draft', 'active', 'archived', 'in_progress', 'completed'];
            if (!VALID_STATUSES.includes(sanitized.status)) {
                throw new Error(`Invalid product status: ${sanitized.status}`);
            }
        }

        if (Object.keys(sanitized).length === 0) {
            throw new Error('No valid update fields provided');
        }

        const { data, error } = await supabaseAdmin
            .from('products')
            .update(sanitized)
            .eq('id', productId)
            .select()
            .single();

        if (error) {
            console.error('Error updating product:', error);
            throw new Error('Failed to update product');
        }

        return data;
    }

    /**
     * Get products for a workspace.
     * @param {string} workspaceId 
     * @returns {Promise<Array>} Array of Product objects
     */
    static async getProductsForWorkspace(workspaceId) {
        const { data, error } = await supabaseAdmin
            .from('products')
            .select('*, primary_output:outputs!primary_output_id(storage_path)')
            .eq('workspace_id', workspaceId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching products:', error);
            throw new Error('Failed to fetch products');
        }

        return data;
    }

    /**
     * Get a specific product by ID.
     * @param {string} productId 
     * @returns {Promise<Object>} Product object
     */
    static async getProductById(productId) {
        const { data, error } = await supabaseAdmin
            .from('products')
            .select('*, primary_output:outputs!primary_output_id(storage_path)')
            .eq('id', productId)
            .maybeSingle();

        if (error) {
            console.error('Error fetching product:', error);
            throw new Error(`Failed to fetch product: ${error.message}`);
        }

        return data || null;
    }
}

module.exports = ProductService;
