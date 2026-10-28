const ProductService = require('./product_service');
const WorkspaceService = require('./workspace_service');
const { supabaseAdmin } = require('./supabase');

async function ownedProduct(userId, productId) {
    const product = await ProductService.getProductById(productId);
    if (!product) throw Object.assign(new Error('Product not found'), { status: 404 });
    const workspace = await WorkspaceService.getOrCreateWorkspace(userId);
    if (product.workspace_id !== workspace.id) {
        throw Object.assign(new Error('Unauthorized'), { status: 403 });
    }
    return product;
}

async function requireOwnedProduct(req, res, next) {
    try {
        req.product = await ownedProduct(req.user.userId, req.params.id);
        next();
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not verify product access' });
    }
}

async function validateProductOutput(productId, outputId) {
    if (outputId === null) return;
    const { data, error } = await supabaseAdmin.from('outputs')
        .select('id').eq('id', outputId).eq('product_id', productId).eq('type', 'image').maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error('Image output does not belong to this product'), { status: 400 });
}

module.exports = { ownedProduct, requireOwnedProduct, validateProductOutput };
