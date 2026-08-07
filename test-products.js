require('dotenv').config();
const { Client } = require('pg');
const supabaseUrl = process.env.SUPABASE_URL.replace('https://', 'postgres://postgres:').replace('.supabase.co', '') + '.supabase.co:6543/postgres';

// We don't have the DB password, but we have the Supabase JS client.
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function test() {
    const { data, error } = await supabase.from('products').select('*').limit(1);
    if (error) {
        console.error('error', error);
    } else {
        console.log('products columns:', Object.keys(data[0] || {}));
    }
}
test();
