require('dotenv').config();
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const path = require('path');



const DB_PATH = path.join(__dirname, 'users.db');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const API_URL = 'http://localhost:3002';

async function runTest() {
    console.log('🧪 Starting Local Verification for Director Mode...');

    // 1. Connect DB
    console.log(`📂 Connecting to database at ${DB_PATH}...`);
    const db = new Database(DB_PATH);

    // 2. Get or Create User
    let user = db.prepare('SELECT * FROM users LIMIT 1').get();
    if (!user) {
        console.log('creating test user...');
        const stmt = db.prepare('INSERT INTO users (email, password_hash, is_active) VALUES (?, ?, 1)');
        stmt.run('test@director.com', 'placeholder_hash');
        user = db.prepare('SELECT * FROM users WHERE email = ?').get('test@director.com');
    }
    console.log(`👤 Using test user: ${user.email} (ID: ${user.id})`);

    // 3. Ensure Credits
    const credits = db.prepare('SELECT credits FROM upscale_credits WHERE user_id = ?').get(user.id);
    if (!credits || credits.credits < 20) {
        console.log('💳 Adding test credits...');
        db.prepare(`INSERT OR IGNORE INTO upscale_credits (user_id, credits, total_purchased, total_used) VALUES (?, 0, 0, 0)`).run(user.id);
        db.prepare('UPDATE upscale_credits SET credits = credits + 100 WHERE user_id = ?').run(user.id);
    }

    // 4. Generate Token
    const token = jwt.sign(
        { userId: user.id, email: user.email },
        JWT_SECRET,
        { expiresIn: '1h' }
    );
    console.log('🔑 JWT Token generated.');

    // 5. Test Flux Casting
    console.log('\n🎭 Testing Casting Tool (Flux)...');
    try {
        const fluxRes = await fetch(`${API_URL}/api/image/generate-flux`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                prompt: 'A futuristic robot samurai, concept art, detailed character sheet',
                aspectRatio: '1:1'
            })
        });

        const fluxData = await fluxRes.json();
        if (fluxData.error) throw new Error(fluxData.error);
        console.log(`✅ Flux Request Success! Prediction ID: ${fluxData.predictionId}`);
        console.log(`   Status: ${fluxData.status}`);

        // Polling Flux Logic (Optional, for now just checking init is fine)
        // We'll trust Replicate status if we get an ID.

    } catch (e) {
        console.error(`❌ Flux Test Failed: ${e.message}`);
        // If connection refused, server might not be running
        if (e.message.includes('ECONNREFUSED')) {
            console.error('⚠️  Is the server running? Run "node server.js" in another terminal!');
        }
        return;
    }

    // 6. Test Director Morph (LTX-2)
    console.log('\n🎥 Testing Director Morph (LTX-2)...');
    try {
        const morphRes = await fetch(`${API_URL}/api/video/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                imageUrl: 'https://replicate.delivery/pbxt/L0...', // Mock URL
                endImageUrl: 'https://replicate.delivery/pbxt/L1...', // Mock URL
                model: 'ltx',
                directorMode: 'morph',
                prompt: 'Morph test'
            })
        });

        const morphData = await morphRes.json();
        if (morphData.error) throw new Error(morphData.error);
        console.log(`✅ Morph Request Success! Prediction ID: ${morphData.predictionId}`);
        console.log(`   Status: ${morphData.status}`);

    } catch (e) {
        console.error(`❌ Morph Test Failed: ${e.message}`);
    }

    console.log('\n✨ Verification check complete. If IDs are returned, the pipeline is connected.');
}

runTest();
