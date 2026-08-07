require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function test() {
    console.log("Fetching workspaces...");
    const { data: workspaces, error: err1 } = await supabase.from('workspaces').select('id').limit(1);
    if (err1) { console.error('err1', err1); return; }
    
    if (!workspaces || workspaces.length === 0) {
        console.log("No workspaces found.");
        return;
    }
    const wId = workspaces[0].id;
    
    console.log("Fetching products...");
    const { data: products, error: err2 } = await supabase.from('products').select('id').limit(1);
    if (err2) { console.error('err2', err2); return; }
    
    if (!products || products.length === 0) {
        console.log("No products found.");
        return;
    }
    const pId = products[0].id;
    
    console.log("Creating output_collections...");
    const { data: coll, error: err3 } = await supabase.from('output_collections').insert({
        product_id: pId,
        job: 'test_job'
    }).select().single();
    if (err3) { console.error('err3', err3); return; }
    
    const cId = coll.id;
    console.log("Created collection:", cId);
    
    console.log("Creating outputs with type...");
    const { data: out, error: err4 } = await supabase.from('outputs').insert({
        product_id: pId,
        collection_id: cId,
        type: 'copy',
        engine: 'test',
        format: 'test',
        metadata: {}
    }).select().single();
    
    if (err4) {
        console.error('err4', err4);
    } else {
        console.log('Success!', out);
    }
}
test();
