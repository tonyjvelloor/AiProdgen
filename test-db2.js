require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function test() {
    console.log("Fetching users...");
    const { data: users, error: err1 } = await supabase.from('users').select('id').limit(1);
    if (err1) { console.error('err1', err1); } else { console.log('Users:', users); }
}
test();
