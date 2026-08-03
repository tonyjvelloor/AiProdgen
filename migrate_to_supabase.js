// migrate_to_supabase.js
require('dotenv').config();
const Database = require('better-sqlite3');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const db = new Database(path.join(__dirname, 'users.db'));

async function migrate() {
    console.log('Starting migration from SQLite to Supabase...');

    const users = db.prepare('SELECT * FROM users').all();
    
    for (const user of users) {
        // 1. Insert user
        const { data: insertedUser, error: userError } = await supabase
            .from('users')
            .insert({
                email: user.email,
                // Note: password_hash isn't in the new schema provided by the user.
                // Assuming Google Auth handles login, or we need to add password back if local auth is kept.
            })
            .select()
            .single();

        if (userError) {
            if (userError.code === '23505') {
                console.log(`User ${user.email} already exists in Supabase. Skipping.`);
                continue;
            }
            console.error(`Error migrating user ${user.email}:`, userError);
            continue;
        }

        console.log(`Migrated user: ${user.email}`);

        // 2. Grant Lifetime Entitlement if they were active or had a plan
        // Adjust logic based on how you identify the 2 existing customers in SQLite
        if (user.plan === 'lifetime' || user.is_active) {
            const { error: entitleError } = await supabase
                .from('user_entitlements')
                .insert({
                    user_id: insertedUser.id,
                    product_id: 'core_platform',
                    razorpay_payment_id: user.razorpay_payment_id || 'manual_migration',
                });

            if (entitleError) {
                console.error(`Error granting entitlement for ${user.email}:`, entitleError);
            } else {
                console.log(`Granted core_platform entitlement to ${user.email}`);
            }
        }
    }
    
    console.log('Migration complete.');
}

// Ensure credentials exist before running
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
    process.exit(1);
}

migrate();
