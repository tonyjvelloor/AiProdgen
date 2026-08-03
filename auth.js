const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const SALT_ROUNDS = 10;

module.exports = {
    // Generate a random password
    generatePassword: () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        let password = '';
        for (let i = 0; i < 12; i++) {
            password += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return password;
    },

    // Hash password
    hashPassword: async (password) => {
        return await bcrypt.hash(password, SALT_ROUNDS);
    },

    // Verify password
    verifyPassword: async (password, hash) => {
        return await bcrypt.compare(password, hash);
    },

    // Register new user after payment
    registerUser: async (email, paymentId, orderId, amountPaid = 0, currency = 'USD') => {
        // Check if email already exists
        if (db.emailExists(email)) {
            throw new Error('Email already registered');
        }

        // Generate random password
        const password = module.exports.generatePassword();
        const passwordHash = await module.exports.hashPassword(password);

        // Create user
        db.createUser(email, passwordHash, paymentId, orderId, amountPaid, currency);

        return { email, password };
    },

    // Register FREE user (Freemium)
    registerFreeUser: async (email, password) => {
        // Check if email already exists
        if (db.emailExists(email)) {
            throw new Error('Email already registered');
        }

        const passwordHash = await module.exports.hashPassword(password);

        // Create user with null payment ID and 0 amount
        db.createUser(email, passwordHash, null, null, 0, 'USD');

        return { email };
    },

    // Login user
    loginUser: async (email, password) => {
        const user = db.getUserByEmail(email);

        if (!user) {
            throw new Error('Invalid email or password');
        }

        if (!user.is_active) {
            throw new Error('Account is deactivated');
        }

        const validPassword = await module.exports.verifyPassword(password, user.password_hash);

        if (!validPassword) {
            throw new Error('Invalid email or password');
        }

        // Generate JWT token
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        return { token, email: user.email };
    },

    // Change password
    changePassword: async (email, oldPassword, newPassword) => {
        const user = db.getUserByEmail(email);

        if (!user) {
            throw new Error('User not found');
        }

        const validPassword = await module.exports.verifyPassword(oldPassword, user.password_hash);

        if (!validPassword) {
            throw new Error('Current password is incorrect');
        }

        const newPasswordHash = await module.exports.hashPassword(newPassword);
        db.updatePassword(email, newPasswordHash);

        return true;
    },

    // Verify JWT token
    verifyToken: (token) => {
        try {
            return jwt.verify(token, JWT_SECRET);
        } catch (error) {
            return null;
        }
    },

    // Middleware to check authentication
    requireAuth: (req, res, next) => {
        const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;

        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const decoded = module.exports.verifyToken(token);

        if (!decoded) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        req.user = decoded;
        next();
    }
};
