require('dotenv').config();
const PolicyEngine = require('../lib/policy_engine');
const db = require('../database');
const { supabaseAdmin } = require('../lib/supabase');

async function run() {
    // get a real user
    const { data: users } = await supabaseAdmin.from('users').select('id, email').limit(1);
    if (!users || users.length === 0) {
        console.log("No users found in database. Please seed users first.");
        process.exit(1);
    }
    const mockUserId = users[0].id;
    console.log("Using user:", mockUserId, users[0].email);
    
    // We'll estimate cost of 1,000,000 outputs which should fail
    const estimatedCosts = {
        outputs: 1000000,
        providerCost: 100,
        storageCost: 10,
        platformCost: 1
    };

    const context = {
        userId: mockUserId,
        jobType: 'photography'
    };

    console.log("Evaluating huge request...");
    const result = await PolicyEngine.evaluateRequest(context, estimatedCosts);
    console.log("Result:", result);
    
    // Test unavailable provider
    // Mock the db function temporarily
    const originalHealth = db.getProviderHealth;
    db.getProviderHealth = async () => 'unavailable';
    
    console.log("\nEvaluating unavailable provider...");
    const result2 = await PolicyEngine.evaluateRequest(context, { outputs: 1 });
    console.log("Result:", result2);
    
    db.getProviderHealth = originalHealth;
    process.exit(0);
}

run();
