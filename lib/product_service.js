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
     * Update an existing product.
     * @param {string} productId 
     * @param {Object} updateData 
     * @returns {Promise<Object>} Updated Product object
     */
    static async updateProduct(productId, updateData) {
        const { data, error } = await supabaseAdmin
            .from('products')
            .update(updateData)
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
            .single();

        if (error) {
            console.error('Error fetching product:', error);
            throw new Error('Failed to fetch product');
        }

        return data;
    }
}

module.exports = ProductService;
