require('dotenv').config();
const { supabase } = require('../lib/supabase');

async function migrateData() {
    console.log('Starting V2 Data Migration...');

    // 1. Get all unique users who have generations
    const { data: generations, error: genError } = await supabase
        .from('generations')
        .select('user_id, image_url, prompt, cost, created_at');

    if (genError) {
        console.error('Error fetching generations:', genError);
        return;
    }

    if (!generations || generations.length === 0) {
        console.log('No generations to migrate. Exiting.');
        return;
    }

    // Group generations by user
    const userGenerations = {};
    for (const gen of generations) {
        if (!userGenerations[gen.user_id]) {
            userGenerations[gen.user_id] = [];
        }
        userGenerations[gen.user_id].push(gen);
    }

    console.log(`Found ${Object.keys(userGenerations).length} users with generations.`);

    for (const userId of Object.keys(userGenerations)) {
        console.log(`\nMigrating user: ${userId}`);

        // 2. Create Workspace
        const { data: workspace, error: workspaceError } = await supabase
            .from('workspaces')
            .insert({
                name: 'Personal Workspace',
                owner_id: userId,
                plan: 'free'
            })
            .select()
            .single();

        if (workspaceError) {
            console.error(`Failed to create workspace for ${userId}:`, workspaceError);
            continue;
        }
        console.log(`  - Created workspace: ${workspace.id}`);

        // 3. Create "Imported Product"
        const { data: product, error: productError } = await supabase
            .from('products')
            .insert({
                workspace_id: workspace.id,
                name: 'Imported Product',
                category: 'Uncategorized',
                status: 'published'
            })
            .select()
            .single();

        if (productError) {
            console.error(`Failed to create product for ${userId}:`, productError);
            continue;
        }
        console.log(`  - Created Imported Product: ${product.id}`);

        // 4. Create Output Collection
        const { data: collection, error: collectionError } = await supabase
            .from('output_collections')
            .insert({
                product_id: product.id,
                job: 'legacy_import',
                status: 'completed'
            })
            .select()
            .single();

        if (collectionError) {
            console.error(`Failed to create collection for ${userId}:`, collectionError);
            continue;
        }
        console.log(`  - Created Output Collection: ${collection.id}`);

        // 5. Create Outputs
        let firstOutputId = null;
        for (const gen of userGenerations[userId]) {
            const { data: output, error: outputError } = await supabase
                .from('outputs')
                .insert({
                    product_id: product.id,
                    collection_id: collection.id,
                    engine: 'photography',
                    format: 'legacy',
                    status: 'completed',
                    metadata: { prompt: gen.prompt, cost: gen.cost },
                    storage_path: gen.image_url,
                    created_at: gen.created_at
                })
                .select()
                .single();

            if (outputError) {
                console.error(`    - Failed to migrate output:`, outputError);
            } else {
                console.log(`    - Migrated generation to output: ${output.id}`);
                if (!firstOutputId) firstOutputId = output.id;
            }
        }

        // 6. Set Primary Output
        if (firstOutputId) {
            const { error: updateError } = await supabase
                .from('products')
                .update({ primary_output_id: firstOutputId })
                .eq('id', product.id);
            
            if (updateError) {
                console.error(`  - Failed to set primary output for product:`, updateError);
            } else {
                console.log(`  - Set primary output for product: ${firstOutputId}`);
            }
        }
    }

    console.log('\nMigration complete.');
}

migrateData().catch(console.error);
