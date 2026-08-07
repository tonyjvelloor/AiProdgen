require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function test() {
    console.log("Fetching output_collections...");
    const { data, error } = await supabase.from('output_collections').select('id').limit(1);
    if (error) { console.error('error', error); } else { console.log('Collections:', data); }
    
    console.log("Fetching outputs...");
    const { data: o, error: eo } = await supabase.from('outputs').select('id').limit(1);
    if (eo) { console.error('error', eo); } else { console.log('Outputs:', o); }
}
test();
