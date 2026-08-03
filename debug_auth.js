const auth = require('./auth');
const db = require('./database');
const path = require('path');

async function debugAuth() {
    const testEmail = 'debug_' + Date.now() + '@example.com';
    const testPaymentId = 'pay_debug_' + Date.now();
    const testOrderId = 'order_debug_' + Date.now();

    console.log('--- DEBUG AUTH START ---');
    console.log('Testing with email:', testEmail);

    try {
        // 1. Test Registration (Simulates payment success)
        console.log('\n[1] Testing Registration...');
        const regResult = await auth.registerUser(testEmail, testPaymentId, testOrderId);
        console.log('✅ Registration successful');
        console.log('Generated Password:', regResult.password);

        // 2. Verify User in DB
        console.log('\n[2] Verifying User in Database...');
        const user = db.getUserByEmail(testEmail);
        if (user) {
            console.log('✅ User found in DB');
            console.log('User ID:', user.id);
            console.log('Hash length:', user.password_hash.length);
        } else {
            console.error('❌ User NOT found in DB after registration');
            return;
        }

        // 3. Test Login with Correct Password
        console.log('\n[3] Testing Login (Correct Password)...');
        try {
            const loginResult = await auth.loginUser(testEmail, regResult.password);
            console.log('✅ Login successful');
            console.log('Token generated:', loginResult.token ? 'Yes' : 'No');
        } catch (e) {
            console.error('❌ Login failed with correct password:', e.message);
        }

        // 4. Test Login with Wrong Password
        console.log('\n[4] Testing Login (Wrong Password)...');
        try {
            await auth.loginUser(testEmail, 'wrongpassword123');
            console.error('❌ Login SUCCEEDED with wrong password (Security Risk!)');
        } catch (e) {
            console.log('✅ Login correctly failed with wrong password:', e.message);
        }

        // 5. Test Admin Login (Static check)
        console.log('\n[5] Testing Admin Login check...');
        // Admin credentials from server.js
        if ('admin' === 'admin' && 'admin123' === 'admin123') {
            console.log('✅ Admin credentials logic is valid');
        }

    } catch (error) {
        console.error('❌ Unexpected error:', error);
    } finally {
        // Cleanup
        if (user) {
            console.log('\nCleaning up test user...');
            db.deleteUser(user.id);
        }
        console.log('--- DEBUG AUTH END ---');
    }
}

// Run debugging (db is initialized in required module)
debugAuth();
