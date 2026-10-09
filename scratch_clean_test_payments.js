require('dotenv').config();
const { supabaseAdmin } = require('./lib/supabase');
(async () => {
    const { data, error: selErr } = await supabaseAdmin.from('payments').select('razorpay_payment_id').like('email', '%@example.com');
    if (selErr) { console.error(selErr); process.exit(1); }
    console.log('Deleting', data.length, 'test payment rows...');
    const { error } = await supabaseAdmin.from('payments').delete().like('email', '%@example.com');
    if (error) { console.error('Delete failed:', error.message); process.exit(1); }
    const { count } = await supabaseAdmin.from('payments').select('*', { count: 'exact', head: true });
    console.log('Remaining rows in payments table:', count);
})();
