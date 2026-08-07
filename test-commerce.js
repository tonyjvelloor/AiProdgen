require('dotenv').config();
const CommerceEngine = require('./lib/engines/commerce');
const OutputService = require('./lib/output_service');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function test() {
    try {
        // Find a random workspace and user
        const { data: users, error: userError } = await supabase.from('users').select('*').limit(1);
        if (userError || !users.length) throw new Error('No user found');
        const user = users[0];

        // Ensure user has a workspace
        const { data: workspaces, error: workspaceError } = await supabase.from('workspaces').select('*').eq('owner_id', user.id).limit(1);
        let workspaceId;
        if (!workspaces || workspaces.length === 0) {
            const { data: newWksp } = await supabase.from('workspaces').insert({
                name: 'Test Workspace',
                owner_id: user.id
            }).select().single();
            workspaceId = newWksp.id;
        } else {
            workspaceId = workspaces[0].id;
        }

        // Ensure workspace has a product
        const { data: products, error: productError } = await supabase.from('products').select('*').eq('workspace_id', workspaceId).limit(1);
        let productId;
        let productContext = { brand: 'Test Brand', category: 'Sneakers', usp: 'Comfortable', audience: 'Runners' };
        
        if (!products || products.length === 0) {
            const { data: newProd } = await supabase.from('products').insert({
                workspace_id: workspaceId,
                name: 'Test Product',
                category: productContext.category,
                usp: productContext.usp,
                audience: productContext.audience,
                brand: productContext.brand
            }).select().single();
            productId = newProd.id;
        } else {
            productId = products[0].id;
        }

        console.log(`Starting run for product ${productId}...`);
        
        // Start Commerce Engine
        const collection = await CommerceEngine.startRun(user.id, productId, 'shopify', productContext, null);
        console.log('Collection created:', collection);

        // Wait 10 seconds for jobs to process
        console.log('Waiting for job runner to process...');
        setTimeout(async () => {
            const { data: outputs } = await supabase.from('outputs').select('*').eq('collection_id', collection.id);
            console.log(`Job finished. Outputs generated: ${outputs.length}`);
            outputs.forEach(o => {
                console.log(`- [${o.type}] ${o.format}: ${o.status}`);
            });
            process.exit(0);
        }, 10000);

    } catch (e) {
        console.error('Test failed:', e);
        process.exit(1);
    }
}
test();
