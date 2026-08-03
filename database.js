const Database = require('better-sqlite3');
const path = require('path');

// Initialize database
const db = new Database(path.join(__dirname, 'users.db'));

// Create users table if not exists
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        razorpay_payment_id TEXT,
        razorpay_order_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT 1
    )
`);

// Create pending orders table (for payment verification)
db.exec(`
    CREATE TABLE IF NOT EXISTS pending_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT UNIQUE NOT NULL,
        email TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT DEFAULT 'USD',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Add currency column if it doesn't exist (migration for existing DBs)
try {
    db.exec(`ALTER TABLE pending_orders ADD COLUMN currency TEXT DEFAULT 'USD'`);
} catch (e) {
    // Column already exists, ignore
}

// Add amount_paid and currency columns to users table (migration)
try {
    db.exec(`ALTER TABLE users ADD COLUMN amount_paid INTEGER DEFAULT 0`);
    db.exec(`ALTER TABLE users ADD COLUMN currency TEXT DEFAULT 'USD'`);
} catch (e) {
    // Columns already exist, ignore
}

// ============ Plan System Migration ============
try { db.exec(`ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free'`); } catch (e) { }
try { db.exec(`ALTER TABLE users ADD COLUMN plan_expires_at INTEGER`); } catch (e) { }
try { db.exec(`ALTER TABLE users ADD COLUMN billing_cycle TEXT DEFAULT 'monthly'`); } catch (e) { }
try { db.exec(`ALTER TABLE users ADD COLUMN monthly_gen_count INTEGER DEFAULT 0`); } catch (e) { }
try { db.exec(`ALTER TABLE users ADD COLUMN monthly_gen_reset INTEGER`); } catch (e) { }
try { db.exec(`ALTER TABLE users ADD COLUMN monthly_ugc_count INTEGER DEFAULT 0`); } catch (e) { }

// Create password reset tokens table
db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at DATETIME NOT NULL,
        used BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// Create generation history table
db.exec(`
    CREATE TABLE IF NOT EXISTS generation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        prompt TEXT,
        image_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
`);

// ============ Upscale Credits System ============

// Upscale credits balance table
db.exec(`
    CREATE TABLE IF NOT EXISTS upscale_credits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        credits INTEGER DEFAULT 0,
        total_purchased INTEGER DEFAULT 0,
        total_used INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
`);

// Credit purchase history
db.exec(`
    CREATE TABLE IF NOT EXISTS credit_purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        credits INTEGER NOT NULL,
        amount_paise INTEGER NOT NULL,
        razorpay_payment_id TEXT,
        razorpay_order_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
`);

// Upscale usage log
db.exec(`
    CREATE TABLE IF NOT EXISTS upscale_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        credits_used INTEGER DEFAULT 1,
        scale INTEGER,
        face_enhance BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )
`);

module.exports = {
    // Create a pending order (before payment)
    createPendingOrder: (orderId, email, amount, currency = 'USD') => {
        const stmt = db.prepare('INSERT INTO pending_orders (order_id, email, amount, currency) VALUES (?, ?, ?, ?)');
        return stmt.run(orderId, email, amount, currency);
    },

    // Get pending order by ID
    getPendingOrder: (orderId) => {
        const stmt = db.prepare('SELECT * FROM pending_orders WHERE order_id = ?');
        return stmt.get(orderId);
    },

    // Delete pending order after successful payment
    deletePendingOrder: (orderId) => {
        const stmt = db.prepare('DELETE FROM pending_orders WHERE order_id = ?');
        return stmt.run(orderId);
    },

    // Create user after successful payment
    createUser: (email, passwordHash, paymentId, orderId, amountPaid = 0, currency = 'USD') => {
        const stmt = db.prepare('INSERT INTO users (email, password_hash, razorpay_payment_id, razorpay_order_id, amount_paid, currency) VALUES (?, ?, ?, ?, ?, ?)');
        return stmt.run(email, passwordHash, paymentId, orderId, amountPaid, currency);
    },

    // Get user by email
    getUserByEmail: (email) => {
        const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
        return stmt.get(email);
    },

    // Update user password
    updatePassword: (email, newPasswordHash) => {
        const stmt = db.prepare('UPDATE users SET password_hash = ? WHERE email = ?');
        return stmt.run(newPasswordHash, email);
    },

    // Check if email already exists
    emailExists: (email) => {
        const stmt = db.prepare('SELECT id FROM users WHERE email = ?');
        return !!stmt.get(email);
    },

    // ============ Password Reset Functions ============

    // Create password reset token
    createResetToken: (email, token, expiresAt) => {
        const stmt = db.prepare('INSERT INTO password_reset_tokens (email, token, expires_at) VALUES (?, ?, ?)');
        return stmt.run(email, token, expiresAt);
    },

    // Get valid reset token
    getValidResetToken: (token) => {
        const stmt = db.prepare(`
            SELECT * FROM password_reset_tokens 
            WHERE token = ? AND used = 0 AND expires_at > datetime('now')
        `);
        return stmt.get(token);
    },

    // Mark token as used
    markTokenUsed: (token) => {
        const stmt = db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token = ?');
        return stmt.run(token);
    },

    // Delete expired tokens (cleanup)
    deleteExpiredTokens: () => {
        const stmt = db.prepare(`DELETE FROM password_reset_tokens WHERE expires_at < datetime('now')`);
        return stmt.run();
    },

    // ============ Generation History Functions ============

    // Log a generation
    logGeneration: (userId, prompt, imageCount) => {
        const stmt = db.prepare('INSERT INTO generation_history (user_id, prompt, image_count) VALUES (?, ?, ?)');
        return stmt.run(userId, prompt, imageCount);
    },

    // Get user generation history
    getGenerationHistory: (userId, limit = 20) => {
        const stmt = db.prepare('SELECT * FROM generation_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?');
        return stmt.all(userId, limit);
    },

    // Get user stats
    getUserStats: (userId) => {
        const stmt = db.prepare(`
            SELECT 
                COUNT(*) as total_generations,
                SUM(image_count) as total_images,
                MAX(created_at) as last_generation
            FROM generation_history WHERE user_id = ?
        `);
        return stmt.get(userId);
    },

    // ============ Admin Functions ============

    // Get overall system stats
    getAdminStats: () => {
        const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
        const totalImages = db.prepare('SELECT SUM(image_count) as count FROM generation_history').get().count || 0;
        const totalGenerations = db.prepare('SELECT COUNT(*) as count FROM generation_history').get().count || 0;

        // Calculate revenue (Sum of user signups + credit purchases)
        const userRevenue = db.prepare('SELECT SUM(amount_paid) as revenue FROM users').get().revenue || 0;
        const creditRevenue = db.prepare('SELECT SUM(amount_paise) as revenue FROM credit_purchases').get().revenue || 0;

        // Convert to major units (assuming stored in cents/paise)
        // Note: Mix of currencies (USD/INR) might need separate handling, 
        // but for simple approximation we sum them up. 
        const totalRevenue = (userRevenue + creditRevenue) / 100;

        return {
            userCount,
            totalImages,
            totalGenerations,
            revenue: totalRevenue
        };
    },

    // Get recent users
    getAllUsers: (limit = 50) => {
        const stmt = db.prepare(`
            SELECT id, email, created_at, is_active 
            FROM users 
            ORDER BY created_at DESC 
            LIMIT ?
        `);
        return stmt.all(limit);
    },

    // Get user by ID
    getUserById: (id) => {
        const stmt = db.prepare('SELECT id, email, created_at, is_active FROM users WHERE id = ?');
        return stmt.get(id);
    },

    // Update user (email and/or password)
    updateUser: (id, updates) => {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        if (!user) return false;

        if (updates.email) {
            db.prepare('UPDATE users SET email = ? WHERE id = ?').run(updates.email, id);
        }
        if (updates.passwordHash) {
            db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(updates.passwordHash, id);
        }
        if (updates.is_active !== undefined) {
            db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(updates.is_active ? 1 : 0, id);
        }
        return true;
    },

    // Delete user
    deleteUser: (id) => {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        if (!user) return false;

        // Delete related data first (foreign keys)
        db.prepare('DELETE FROM generation_history WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM upscale_credits WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM upscale_usage WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM credit_purchases WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM ugc_projects WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM ugc_gallery WHERE user_id = ?').run(id);

        // Delete user
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
        return true;
    },

    // ============ Upscale Credits Functions ============

    // Get user credit balance
    getUserCredits: (userId) => {
        const stmt = db.prepare('SELECT credits FROM upscale_credits WHERE user_id = ?');
        const result = stmt.get(userId);
        return result ? result.credits : 0;
    },

    // Get full credit info
    getUserCreditInfo: (userId) => {
        const stmt = db.prepare('SELECT * FROM upscale_credits WHERE user_id = ?');
        return stmt.get(userId) || { credits: 0, total_purchased: 0, total_used: 0 };
    },

    // Initialize credit record for user (if not exists)
    initUserCredits: (userId) => {
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO upscale_credits (user_id, credits, total_purchased, total_used) 
            VALUES (?, 0, 0, 0)
        `);
        return stmt.run(userId);
    },

    // Add credits (after purchase)
    addCredits: (userId, credits) => {
        // First ensure record exists
        const initStmt = db.prepare(`
            INSERT OR IGNORE INTO upscale_credits (user_id, credits, total_purchased, total_used) 
            VALUES (?, 0, 0, 0)
        `);
        initStmt.run(userId);

        // Then update
        const stmt = db.prepare(`
            UPDATE upscale_credits 
            SET credits = credits + ?, total_purchased = total_purchased + ?, updated_at = CURRENT_TIMESTAMP 
            WHERE user_id = ?
        `);
        return stmt.run(credits, credits, userId);
    },

    // Use credits (deduct on upscale)
    useCredits: (userId, creditsToUse = 1) => {
        const stmt = db.prepare(`
            UPDATE upscale_credits 
            SET credits = credits - ?, total_used = total_used + ?, updated_at = CURRENT_TIMESTAMP 
            WHERE user_id = ? AND credits >= ?
        `);
        const result = stmt.run(creditsToUse, creditsToUse, userId, creditsToUse);
        return result.changes > 0; // Returns true if successful, false if insufficient credits
    },

    // Record credit purchase
    recordCreditPurchase: (userId, credits, amountPaise, paymentId, orderId) => {
        const stmt = db.prepare(`
            INSERT INTO credit_purchases (user_id, credits, amount_paise, razorpay_payment_id, razorpay_order_id) 
            VALUES (?, ?, ?, ?, ?)
        `);
        return stmt.run(userId, credits, amountPaise, paymentId, orderId);
    },

    // Log upscale usage
    logUpscaleUsage: (userId, creditsUsed, scale, faceEnhance) => {
        const stmt = db.prepare(`
            INSERT INTO upscale_usage (user_id, credits_used, scale, face_enhance) 
            VALUES (?, ?, ?, ?)
        `);
        return stmt.run(userId, creditsUsed, scale, faceEnhance ? 1 : 0);
    },

    // Get user's purchase history
    getCreditPurchaseHistory: (userId, limit = 10) => {
        const stmt = db.prepare(`
            SELECT * FROM credit_purchases 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT ?
        `);
        return stmt.all(userId, limit);
    },

    // Get user's upscale usage history
    getUpscaleUsageHistory: (userId, limit = 20) => {
        const stmt = db.prepare(`
            SELECT * FROM upscale_usage 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT ?
        `);
        return stmt.all(userId, limit);
    },

    // UGC Projects
    createUGCProject: (userId, name, workflowJson, thumbnailUrl, isPublic = 0) => {
        const stmt = db.prepare(`
            INSERT INTO ugc_projects (user_id, name, workflow_json, thumbnail_url, is_public)
            VALUES (?, ?, ?, ?, ?)
        `);
        return stmt.run(userId, name, workflowJson, thumbnailUrl, isPublic ? 1 : 0);
    },
    updateUGCProject: (id, userId, name, workflowJson, thumbnailUrl, isPublic) => {
        const stmt = db.prepare(`
            UPDATE ugc_projects 
            SET name = ?, workflow_json = ?, thumbnail_url = ?, is_public = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ?
        `);
        return stmt.run(name, workflowJson, thumbnailUrl, isPublic ? 1 : 0, id, userId);
    },
    getUserProjects: (userId) => {
        const stmt = db.prepare('SELECT * FROM ugc_projects WHERE user_id = ? ORDER BY updated_at DESC');
        return stmt.all(userId);
    },
    getProjectById: (id) => {
        const stmt = db.prepare('SELECT * FROM ugc_projects WHERE id = ?');
        return stmt.get(id);
    },

    // UGC Gallery
    addToGallery: (userId, projectId, type, url, prompt, isPublic = 0) => {
        const stmt = db.prepare(`
            INSERT INTO ugc_gallery (user_id, project_id, type, url, prompt, is_public)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        return stmt.run(userId, projectId, type, url, prompt, isPublic ? 1 : 0);
    },
    getPublicGallery: (limit = 50) => {
        const stmt = db.prepare(`
            SELECT g.*, u.email 
            FROM ugc_gallery g
            JOIN users u ON g.user_id = u.id
            WHERE g.is_public = 1
            ORDER BY g.created_at DESC
            LIMIT ?
        `);
        return stmt.all(limit);
    },
    getUserGallery: (userId) => {
        const stmt = db.prepare('SELECT * FROM ugc_gallery WHERE user_id = ? ORDER BY created_at DESC');
        return stmt.all(userId);
    },
    toggleGalleryPublic: (id, userId, isPublic) => {
        const stmt = db.prepare('UPDATE ugc_gallery SET is_public = ? WHERE id = ? AND user_id = ?');
        return stmt.run(isPublic ? 1 : 0, id, userId);
    },

    // ============ Plan System Functions ============

    getUserPlan: (userId) => {
        const stmt = db.prepare('SELECT plan, plan_expires_at, billing_cycle, monthly_gen_count, monthly_gen_reset, monthly_ugc_count FROM users WHERE id = ?');
        const user = stmt.get(userId);
        if (!user) return { plan: 'free', monthly_gen_count: 0, monthly_ugc_count: 0 };

        // Auto-reset monthly counters if past reset date
        const now = Math.floor(Date.now() / 1000);
        if (user.monthly_gen_reset && now > user.monthly_gen_reset) {
            const nextReset = now + (30 * 24 * 60 * 60); // 30 days from now
            db.prepare('UPDATE users SET monthly_gen_count = 0, monthly_ugc_count = 0, monthly_gen_reset = ? WHERE id = ?').run(nextReset, userId);
            user.monthly_gen_count = 0;
            user.monthly_ugc_count = 0;
        }

        // Check plan expiry
        if (user.plan !== 'free' && user.plan !== 'lifetime_founder' && user.plan_expires_at && now > user.plan_expires_at) {
            db.prepare("UPDATE users SET plan = 'free' WHERE id = ?").run(userId);
            user.plan = 'free';
        }

        return user;
    },

    setUserPlan: (userId, plan, billingCycle = 'monthly') => {
        const now = Math.floor(Date.now() / 1000);
        const duration = billingCycle === 'yearly' ? 365 * 24 * 60 * 60 : 30 * 24 * 60 * 60;
        const expiresAt = now + duration;
        const resetAt = now + (30 * 24 * 60 * 60);
        const stmt = db.prepare('UPDATE users SET plan = ?, billing_cycle = ?, plan_expires_at = ?, monthly_gen_count = 0, monthly_ugc_count = 0, monthly_gen_reset = ? WHERE id = ?');
        return stmt.run(plan, billingCycle, expiresAt, resetAt, userId);
    },

    incrementGenCount: (userId) => {
        const stmt = db.prepare('UPDATE users SET monthly_gen_count = monthly_gen_count + 1 WHERE id = ?');
        return stmt.run(userId);
    },

    incrementUGCCount: (userId) => {
        const stmt = db.prepare('UPDATE users SET monthly_ugc_count = monthly_ugc_count + 1 WHERE id = ?');
        return stmt.run(userId);
    },

    // ============ Founder Migration ============

    migrateFounders: () => {
        const founderEmails = [
            'eng_harsh@yahoo.com',
            'jainik.shah.fms17@gmail.com',
            'tonyjvelloor@gmail.com'
        ];
        const stmt = db.prepare(`
            UPDATE users 
            SET plan = 'lifetime_founder', 
                plan_expires_at = NULL, 
                billing_cycle = 'lifetime'
            WHERE email = ? AND (plan IS NULL OR plan = 'free')
        `);
        let migrated = 0;
        for (const email of founderEmails) {
            const result = stmt.run(email);
            if (result.changes > 0) migrated++;
        }
        console.log(`[Founder Migration] ${migrated} accounts migrated to lifetime_founder`);
        return migrated;
    }
};
