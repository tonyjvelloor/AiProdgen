const { Redis } = require('@upstash/redis');
const { Ratelimit } = require('@upstash/ratelimit');

// Initialize Redis client
// Note: If keys are missing, we mock the limiters to always pass so development doesn't break.
const hasRedis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN;
let redis;
if (hasRedis) {
    redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
}

/**
 * Creates a mock limiter for local development if Redis is not configured.
 */
const createMockLimiter = () => ({
    limit: async () => ({ success: true, pending: Promise.resolve() })
});

/**
 * Layered Rate Limiters based on the Sprint 1 spec.
 */

// Login/Auth: 5 requests per minute per IP
const loginLimiter = hasRedis 
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 m'), analytics: true, prefix: 'ratelimit:login' })
    : createMockLimiter();

// General API (e.g. fetching models, metadata): 60 requests per minute per IP
const apiLimiter = hasRedis 
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(60, '1 m'), analytics: true, prefix: 'ratelimit:api' })
    : createMockLimiter();

// Layer 1: Anonymous (20 per hour)
const anonymousLimiter = hasRedis 
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, '1 h'), analytics: true, prefix: 'ratelimit:anon' })
    : createMockLimiter();

// Layer 2: Authenticated (100 per hour)
const authenticatedLimiter = hasRedis 
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(100, '1 h'), analytics: true, prefix: 'ratelimit:auth' })
    : createMockLimiter();

// Layer 3: AI Endpoints
const campaignLimiter = hasRedis
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, '1 h'), analytics: true, prefix: 'ratelimit:job:campaign' })
    : createMockLimiter();

const photographyLimiter = hasRedis
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 h'), analytics: true, prefix: 'ratelimit:job:photo' })
    : createMockLimiter();

// Email verification: 3 requests per hour
const emailVerifyLimiter = hasRedis
    ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, '1 h'), analytics: true, prefix: 'ratelimit:emailverify' })
    : createMockLimiter();

/**
 * Express Middlewares
 */

const getClientIp = (req) => {
    // Vercel forwards the real IP in the x-real-ip or x-forwarded-for header
    return req.headers['x-forwarded-for']?.split(',')[0] 
        || req.headers['x-real-ip'] 
        || req.socket?.remoteAddress 
        || 'unknown-ip';
};

const requireLoginRateLimit = async (req, res, next) => {
    try {
        const ip = getClientIp(req);
        const { success } = await loginLimiter.limit(ip);
        if (!success) {
            return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
        }
        next();
    } catch (error) {
        console.error('Rate limit error:', error);
        next(); // Fail open if Redis is down
    }
};

const requireApiRateLimit = async (req, res, next) => {
    try {
        const ip = getClientIp(req);
        const { success } = await apiLimiter.limit(ip);
        if (!success) {
            return res.status(429).json({ error: 'Too many requests. Please slow down.' });
        }
        next();
    } catch (error) {
        console.error('Rate limit error:', error);
        next();
    }
};

const requireRateLimit = (jobType = 'default') => async (req, res, next) => {
    try {
        const ip = getClientIp(req);
        const userId = req.user ? req.user.userId : null;
        
        // Layer 1 & 2
        if (!userId) {
            const { success } = await anonymousLimiter.limit(ip);
            if (!success) return res.status(429).json({ error: 'Anonymous rate limit exceeded (20/hr). Please log in.' });
        } else {
            const { success } = await authenticatedLimiter.limit(userId);
            if (!success) return res.status(429).json({ error: 'Global authenticated rate limit exceeded (100/hr).' });
        }

        // Layer 3
        if (jobType === 'campaign') {
            const identifier = userId || ip;
            const { success } = await campaignLimiter.limit(identifier);
            if (!success) return res.status(429).json({ error: 'Campaign production limit exceeded (10/hr).' });
        } else if (jobType === 'photography') {
            const identifier = userId || ip;
            const { success } = await photographyLimiter.limit(identifier);
            if (!success) return res.status(429).json({ error: 'Photography limit exceeded (30/hr).' });
        }

        next();
    } catch (error) {
        console.error('Rate limit error:', error);
        next(); // fail open
    }
};

const requireGenerateRateLimit = requireRateLimit('photography');

const requireEmailVerifyRateLimit = async (req, res, next) => {
    try {
        const identifier = req.user ? req.user.id : getClientIp(req);
        const { success } = await emailVerifyLimiter.limit(identifier);
        if (!success) {
            return res.status(429).json({ error: 'Too many verification emails sent. Please try again later.' });
        }
        next();
    } catch (error) {
        console.error('Rate limit error:', error);
        next();
    }
};

module.exports = {
    requireLoginRateLimit,
    requireApiRateLimit,
    requireGenerateRateLimit,
    requireRateLimit,
    requireEmailVerifyRateLimit
};
