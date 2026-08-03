const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
require('dotenv').config();

// Import auth and database modules
const auth = require('./auth');
const db = require('./database');
const email = require('./email');
const fb = require('./services/facebook');
const replicate = require('./services/replicate');
const cookieParser = require('cookie-parser');
const { GoogleGenAI } = require('@google/genai');

// ... (existing code)

const getClientInfo = (req) => {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const { _fbp, _fbc } = req.cookies || {};
    return { ip, userAgent, fbp: _fbp, fbc: _fbc };
};

// Initialize Razorpay (if keys are available)
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    const Razorpay = require('razorpay');
    razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
    });
    console.log('Razorpay initialized');
} else {
    console.warn('WARNING: Razorpay keys not configured. Payment features disabled.');
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://cdnjs.cloudflare.com", "https://checkout.razorpay.com", "https://connect.facebook.net", "https://cdn.jsdelivr.net"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:", "https://www.facebook.com"],
            connectSrc: ["'self'", "https://api.razorpay.com", "https://www.facebook.com"],
            frameSrc: ["https://api.razorpay.com", "https://www.facebook.com", "https://www.youtube.com", "https://youtube.com"],
        },
    },
}));

app.use(cookieParser());

// Trust first proxy (Nginx/reverse proxy)
app.set('trust proxy', 1);

// Gzip compression
app.use(compression());

// CORS - Restrict in production
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000', 'http://localhost:3002', 'http://72.61.174.111', 'http://72.61.174.111:3000', 'https://aiprodgen.online', 'https://www.aiprodgen.online'];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps, curl, etc)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.warn(`CORS blocked request from: ${origin}`);
            callback(null, true); // Allow in dev, block in prod by removing this line
        }
    },
    credentials: true
}));

// Global rate limiter (100 requests per minute per IP)
const globalLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 100,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(globalLimiter);

// Stricter rate limit for API generation endpoints
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10, // Conservative limit for free tier (allows breathing room)
    message: { error: 'Rate limit exceeded. Please wait before generating more images.' },
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Fallback API key from environment
const DEFAULT_API_KEY = process.env.GEMINI_API_KEY;

if (!DEFAULT_API_KEY) {
    console.warn("WARNING: GEMINI_API_KEY is not set in environment. Users must provide their own API key.");
}

// Sleep helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Request queue to manage rate limiting
const requestQueue = new Map(); // Map of apiKey -> { lastRequestTime, requestCount }

async function waitForRateLimit(apiKey) {
    const now = Date.now();
    const state = requestQueue.get(apiKey) || { lastRequestTime: 0, requestCount: 0, windowStart: now };

    // Reset counter every minute
    if (now - state.windowStart > 60000) {
        state.requestCount = 0;
        state.windowStart = now;
    }

    // Google Free Tier Optimization: 15 requests per minute
    // We allow 15 RPM which is the official free tier limit
    if (state.requestCount >= 15) {
        const waitTime = 60000 - (now - state.windowStart);
        if (waitTime > 0) {
            console.log(`Rate limit prevention: waiting ${Math.ceil(waitTime / 1000)}s before next request`);
            await sleep(waitTime + 1000);
            state.requestCount = 0;
            state.windowStart = Date.now();
        }
    }

    // Google Free Tier: 4 second delay between requests
    // This optimizes speed while staying safe (15 RPM = 1 req/4s)
    const timeSinceLastRequest = now - state.lastRequestTime;
    if (timeSinceLastRequest < 4000) {
        const waitTime = 4000 - timeSinceLastRequest;
        console.log(`⏱️  Free tier throttle: waiting ${(waitTime / 1000).toFixed(1)}s before next request`);
        await sleep(waitTime);
    }

    state.lastRequestTime = Date.now();
    state.requestCount++;
    requestQueue.set(apiKey, state);
}

// Universal Fetch Wrapper with retry logic and rate limit handling
async function callGoogleAPI(url, payload, apiKey, retries = 5) {
    if (!apiKey) {
        throw new Error("API Key is required. Please add your Gemini API key in Settings.");
    }

    // Wait for rate limit window (re-enabled for free tier)
    await waitForRateLimit(apiKey);

    for (let attempt = 1; attempt <= retries; attempt++) {
        const response = await fetch(`${url}?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            return await response.json();
        }

        // Handle rate limiting with exponential backoff
        if (response.status === 429) {
            const errorText = await response.text();
            console.error(`🚨 429 Error Details:`, errorText);

            if (attempt < retries) {
                const waitTime = Math.pow(2, attempt + 3) * 1000; // 16s, 32s, 64s, 128s, 256s
                console.log(`Rate limited (429), waiting ${waitTime / 1000}s before retry ${attempt + 1}/${retries}...`);
                await sleep(waitTime);
                continue;
            }
            throw new Error("Rate limit exceeded. Please wait 1-2 minutes and try again with fewer images.");
        }

        const txt = await response.text();

        if (response.status === 400) {
            try {
                const errData = JSON.parse(txt);
                throw new Error(errData.error?.message || "Invalid API request.");
            } catch (e) {
                if (e.message.includes("API") || e.message.includes("Invalid")) throw e;
                throw new Error("Invalid API request. " + txt.substring(0, 100));
            }
        } else if (response.status === 401 || response.status === 403) {
            throw new Error("Invalid API Key. Please check your Gemini API key in Settings.");
        } else if (response.status === 404) {
            throw new Error("Model not found. The API model may not be available.");
        }
        throw new Error(`API Error ${response.status}: ${txt.substring(0, 200)}`);
    }
}

// Get API key
function getApiKey(req) {
    return req.body.apiKey || req.headers['x-api-key'] || DEFAULT_API_KEY;
}

// Preprompt templates
const MARKETING_PREPROMPTS = {
    default: "You are a premium e-commerce copywriter. Generate three distinct, persuasive marketing angles. Use clear Markdown headings for each angle.",
    luxury: "You are a luxury brand copywriter specializing in premium, aspirational messaging. Generate three distinct marketing angles that emphasize exclusivity, craftsmanship, and status. Use sophisticated language and Markdown headings.",
    utility: "You are a practical, benefit-focused copywriter. Generate three distinct marketing angles that emphasize functionality, problem-solving, and value for money. Use clear, direct language and Markdown headings.",
    sustainability: "You are an eco-conscious brand copywriter. Generate three distinct marketing angles that emphasize environmental responsibility, ethical sourcing, and sustainable practices. Use authentic, purpose-driven language and Markdown headings.",
    tech: "You are a tech product copywriter. Generate three distinct marketing angles that emphasize innovation, cutting-edge features, and technical excellence. Use dynamic, future-forward language and Markdown headings.",
    lifestyle: "You are a lifestyle brand copywriter. Generate three distinct marketing angles that emphasize experiences, emotions, and how the product fits into the customer's ideal life. Use relatable, aspirational language and Markdown headings.",
    minimal: "You are a minimalist brand copywriter. Generate three concise, impactful marketing angles using clean, simple language. Focus on essential features and elegant simplicity. Use Markdown headings."
};

// 1. Generate Text Route
app.post('/api/generate-text', auth.requireAuth, apiLimiter, async (req, res) => {
    try {
        const { prompt, prepromptType } = req.body;
        const apiKey = getApiKey(req);
        const userId = req.user.userId;

        const systemPrompt = MARKETING_PREPROMPTS[prepromptType] || MARKETING_PREPROMPTS.default;

        const data = await callGoogleAPI(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                systemInstruction: { parts: [{ text: systemPrompt }] }
            },
            apiKey
        );

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

        // Log generation history (Text only counts as 0 images but we log it if needed, or we can skip)
        // For now we only log image generations in history as per schema "image_count"

        res.json({ text });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Generate Image Route - Uses Gemini 2.0 Flash
app.post('/api/generate-image', auth.requireAuth, apiLimiter, async (req, res) => {
    try {
        const { prompt, images, mode, modelEthnicity, modelGender } = req.body;
        const userId = req.user.userId;

        // Plan-based API key resolution
        const userPlan = db.getUserPlan(userId);
        const planConfig = getPlanConfig(userPlan.plan);
        let apiKey;

        // Universal BYOK: all plans can use own key for higher limits
        const userKey = req.body.apiKey || req.headers['x-api-key'];

        if (userKey) {
            // User provided their own API key → use BYOK limit
            apiKey = userKey;
            const byokLimit = planConfig.byok_gen_limit;
            if (byokLimit !== Infinity && userPlan.monthly_gen_count >= byokLimit) {
                return res.status(429).json({ error: `Monthly BYOK limit reached (${byokLimit} shots). Upgrade your plan for more.` });
            }
        } else if (planConfig.requires_byok) {
            // Free plan: no server key fallback, must have own key
            return res.status(403).json({ error: 'Free plan requires your own Gemini API key. Add it in Settings.' });
        } else if (userPlan.plan === 'lifetime_founder') {
            // Founder plan uses credits
            apiKey = DEFAULT_API_KEY;
            const creditInfo = db.getUserCreditInfo(userId);
            if ((creditInfo?.credits || 0) < 1) {
                return res.status(429).json({ error: 'Insufficient credits. Please top up your credit balance.' });
            }
        } else {
            // Paid plan without own key → use server key with standard limit
            apiKey = DEFAULT_API_KEY;
            if (planConfig.gen_limit !== Infinity && userPlan.monthly_gen_count >= planConfig.gen_limit) {
                return res.status(429).json({
                    error: `Monthly server generation limit reached (${planConfig.gen_limit}). Add your own Gemini API key in Settings for more generations.`
                });
            }
        }

        let base64Image = null;

        // Build prompt parts
        const contentsParts = [];

        if (images && images.length > 0) {
            // Image-to-Image: Edit existing images
            if (mode === 'fashion') {
                const eth = modelEthnicity || 'South Asian';
                const gen = modelGender || 'Female';
                const env = req.body.modelEnvironment || 'Professional Studio';
                contentsParts.push({ text: `CRITICAL EDITING INSTRUCTIONS: Transform this image to match: \n1. SUBJECT: ${eth} ${gen} Model. \n2. LOCATION: ${env}. \n3. DETAILS: ${prompt}. \nEnsure Face/Skin/Background matches strict constraints.` });
            } else {
                contentsParts.push({ text: `Edit this product image with the following instructions: ${prompt}` });
            }
            images.forEach(img => contentsParts.push({ inlineData: img }));
        } else {
            // Text-to-Image: Generate new product image
            if (mode === 'fashion') {
                const eth = modelEthnicity || 'South Asian';
                const gen = modelGender || 'Female';
                const env = req.body.modelEnvironment || 'Professional Studio';

                // Enhanced Prompt for Consistency
                const consistencyMarker = "Use a consistent character face and body structure.";

                // Structured Prompt with CRITICAL constraints
                contentsParts.push({ text: `CRITICAL INSTRUCTIONS: Generate a Professional Fashion Photo. \n1. SUBJECT: ${eth} ${gen} Model. (Face and skin tone MUST match ${eth} ethnicity). \n2. LOCATION: ${env}. (Background must be clearly ${env}). \n3. CLOTHING/ACTION: ${prompt}. \n4. STYLE: Realistic, High Quality. ${consistencyMarker}` });
            } else {
                contentsParts.push({ text: `Generate a high-quality professional product photograph. ${prompt}` });
            }
        }

        console.log("Sending prompt:", contentsParts[0].text);

        const data = await callGoogleAPI(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`,
            {
                contents: [{ parts: contentsParts }],
                generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
            },
            apiKey,
            3
        );

        const parts = data.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find(p => p.inlineData);
        if (imagePart) {
            base64Image = imagePart.inlineData.data;
        }

        if (!base64Image) {
            const finishReason = data.candidates?.[0]?.finishReason;
            if (finishReason === 'SAFETY') {
                throw new Error("Image blocked by safety filters. Try different prompt.");
            }
            const textPart = parts.find(p => p.text);
            if (textPart) {
                console.log("Model returned text instead of image:", textPart.text.substring(0, 200));
            }
            throw new Error("Could not generate image. Try rephrasing your prompt.");
        }

        // Log successful generation and track usage
        if (userId && userId > 0) {
            db.logGeneration(userId, prompt, 1);
            // Increment monthly gen count for paid plans
            if (planConfig.type === 'server' && userPlan.plan !== 'lifetime_founder') {
                db.incrementGenCount(userId);
            }
            // Deduct credit for founder plan
            if (userPlan.plan === 'lifetime_founder') {
                db.useCredits(userId, 1);
            }
        }

        res.json({ image: base64Image });

    } catch (error) {
        if (error.message.includes("Rate limit")) {
            console.warn("⚠️  API Rate Limit hit (Handling via client retry):", error.message);
            res.status(500).json({ error: error.message });
        } else {
            console.error("❌ Image Gen Error:", error.message);
            res.status(500).json({ error: error.message });
        }
    }
});

// 3. Validate API Key Route
app.post('/api/validate-key', async (req, res) => {
    try {
        const apiKey = getApiKey(req);

        if (!apiKey) {
            return res.json({ valid: false, message: "No API key provided" });
        }

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);

        if (response.ok) {
            res.json({ valid: true, message: "API key is valid" });
        } else if (response.status === 401 || response.status === 403) {
            res.json({ valid: false, message: "Invalid API key" });
        } else {
            res.json({ valid: false, message: "Could not validate API key" });
        }
    } catch (error) {
        res.status(500).json({ valid: false, message: error.message });
    }
});

// 4. Real-ESRGAN Upscale Route (using Replicate API)
app.post('/api/upscale-esrgan', auth.requireAuth, apiLimiter, async (req, res) => {
    try {
        const { image, scale = 4, face_enhance = false } = req.body;
        const replicateApiKey = process.env.REPLICATE_API_TOKEN;

        // Plan gating: Creator+ only
        const userPlan = db.getUserPlan(req.user.userId);
        const planConfig = getPlanConfig(userPlan.plan);
        if (planConfig.upscale <= 0) {
            return res.status(403).json({ error: 'HD Upscaling requires Creator plan or higher. Upgrade to unlock!' });
        }

        if (!image) {
            return res.status(400).json({ error: 'No image provided' });
        }

        if (!replicateApiKey) {
            return res.status(500).json({ error: 'REPLICATE_API_TOKEN not configured on server' });
        }

        // Validate scale (2, 4, or 8)
        const validScales = [2, 4, 8];
        const upscaleScale = validScales.includes(scale) ? scale : 4;
        const enableFaceEnhance = Boolean(face_enhance);

        console.log(`🔍 Upscaling image at ${upscaleScale}x using Real-ESRGAN (face_enhance: ${enableFaceEnhance})...`);

        // Call Replicate API directly
        const response = await fetch('https://api.replicate.com/v1/predictions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${replicateApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                version: 'f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa',
                input: {
                    image: `data:image/png;base64,${image}`,
                    scale: upscaleScale,
                    face_enhance: enableFaceEnhance
                }
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || 'Replicate API error');
        }

        const prediction = await response.json();

        // Poll for completion (Replicate is async)
        let result = prediction;
        let attempts = 0;
        while (result.status !== 'succeeded' && result.status !== 'failed' && attempts < 60) {
            await sleep(2000);
            const pollResponse = await fetch(result.urls.get, {
                headers: { 'Authorization': `Bearer ${replicateApiKey}` }
            });
            result = await pollResponse.json();
            attempts++;
        }

        if (result.status === 'failed') {
            throw new Error(result.error || 'Upscaling failed');
        }

        if (!result.output) {
            throw new Error('No output received from upscaler');
        }

        // Fetch the upscaled image and convert to base64
        const imageResponse = await fetch(result.output);
        const imageBuffer = await imageResponse.arrayBuffer();
        const upscaledBase64 = Buffer.from(imageBuffer).toString('base64');

        console.log(`✅ Upscaling complete (${upscaleScale}x)`);

        res.json({
            image: upscaledBase64,
            scale: upscaleScale,
            originalSize: image.length,
            upscaledSize: upscaledBase64.length
        });

    } catch (error) {
        console.error('❌ Upscale Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============ Upscale Credits API ============

// Credit packages (amount in paise)
const CREDIT_PACKAGES = {
    starter: { credits: 50, amount_inr: 39900, amount_usd: 500, name: 'Starter Monthly' },
    value: { credits: 150, amount_inr: 99900, amount_usd: 1200, name: 'Starter Yearly (Deal)' },
    pro: { credits: 200, amount_inr: 149900, amount_usd: 2000, name: 'Pro Creator' },
    agency: { credits: 1000, amount_inr: 499900, amount_usd: 6000, name: 'Agency Power' }
};

// ============ Lifetime Deal Plans ============
// gen_limit = server-key gens/mo, byok_gen_limit = own-key gens/mo
const PLANS = {
    free_explorer: { gen_limit: 0, byok_gen_limit: 20, upscale: 0, ugc: 0, director: false, veo: false, requires_byok: true, watermark: true, templates: 'none', bulk: false, commercial: false },
    hobbyist_ltd: { gen_limit: 0, byok_gen_limit: 500, upscale: 0, ugc: 0, director: false, veo: false, requires_byok: true, watermark: false, templates: 'basic', bulk: false, commercial: false },
    pro_founder_ltd: { gen_limit: 0, byok_gen_limit: 3000, upscale: 50, ugc: 10, director: true, veo: true, requires_byok: true, watermark: false, templates: 'advanced', bulk: false, commercial: false },
    agency_ltd: { gen_limit: 0, byok_gen_limit: Infinity, upscale: 200, ugc: 50, director: true, veo: true, requires_byok: true, watermark: false, templates: 'advanced', bulk: true, commercial: true },
    lifetime_founder: { gen_limit: Infinity, byok_gen_limit: Infinity, upscale: 999, ugc: 50, director: true, veo: true, requires_byok: false, watermark: false, templates: 'advanced', bulk: true, commercial: true }
};

// Backward-compat: map legacy plan names to new ones
const PLAN_ALIASES = { free: 'free_explorer', creator: 'hobbyist_ltd', pro: 'pro_founder_ltd', agency: 'agency_ltd' };

const PLAN_PRICES = {
    hobbyist_ltd: { onetime_usd: 4900 },  // $49
    pro_founder_ltd: { onetime_usd: 9700 },  // $97
    agency_ltd: { onetime_usd: 19700 }   // $197
};

// Helper: Check plan access
function getPlanConfig(planName) {
    const resolved = PLAN_ALIASES[planName] || planName;
    return PLANS[resolved] || PLANS.free_explorer;
}

// Get credit balance
app.get('/api/credits/balance', auth.requireAuth, (req, res) => {
    try {
        const user = db.getUserByEmail(req.user.email);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const creditInfo = db.getUserCreditInfo(user.id);
        res.json({
            credits: creditInfo.credits || 0,
            total_purchased: creditInfo.total_purchased || 0,
            total_used: creditInfo.total_used || 0
        });
    } catch (error) {
        console.error('❌ Get credits error:', error.message);
        res.status(500).json({ error: 'Failed to get credit balance' });
    }
});

// Get available packages
app.get('/api/credits/packages', (req, res) => {
    res.json(CREDIT_PACKAGES);
});

// Create order for credit purchase
app.post('/api/credits/purchase', auth.requireAuth, async (req, res) => {
    try {
        if (!razorpay) {
            return res.status(500).json({ error: 'Razorpay not configured' });
        }

        const { packageId, currency = 'INR' } = req.body;
        // Actually, let's look at the implementation.
        const pkg = CREDIT_PACKAGES[packageId];

        if (!pkg) {
            return res.status(400).json({ error: 'Invalid package' });
        }

        // Determine amount and currency
        // Default to INR if not specified or invalid?
        // Let's use the requested currency if valid.
        const useCurrency = (currency === 'USD') ? 'USD' : 'INR';
        const amount = (useCurrency === 'USD') ? pkg.amount_usd : pkg.amount_inr;

        const order = await razorpay.orders.create({
            amount: amount,
            currency: useCurrency,
            receipt: `credit_${Date.now()}`,
            notes: {
                type: 'credit_purchase',
                package: packageId,
                credits: pkg.credits,
                email: req.user.email
            }
        });

        console.log(`💳 Credit purchase order created: ${order.id} for ${pkg.credits} credits (${useCurrency} ${amount / 100})`);

        // Track InitiateCheckout with value/currency
        const { ip, userAgent, fbp, fbc } = getClientInfo(req);
        fb.trackInitiateCheckout(req.user.email, amount / 100, useCurrency, ip, userAgent, fbp, fbc).catch(e => console.error(e));

        res.json({
            orderId: order.id,
            amount: amount,
            currency: useCurrency,
            credits: pkg.credits,
            packageName: pkg.name,
            key: process.env.RAZORPAY_KEY_ID
        });
    } catch (error) {
        console.error('❌ Create credit order error:', error.message);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

// Verify payment and add credits
app.post('/api/credits/verify', auth.requireAuth, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, packageId, currency } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing payment details' });
        }

        // Verify signature
        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body)
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            console.error('❌ Invalid payment signature');
            return res.status(400).json({ error: 'Invalid payment signature' });
        }

        const pkg = CREDIT_PACKAGES[packageId];
        if (!pkg) {
            return res.status(400).json({ error: 'Invalid package' });
        }

        // Get user
        const user = db.getUserByEmail(req.user.email);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Determine amount logged
        const useCurrency = (currency === 'USD') ? 'USD' : 'INR';
        const amount = (useCurrency === 'USD') ? pkg.amount_usd : pkg.amount_inr;

        // Add credits and record purchase
        db.addCredits(user.id, pkg.credits);
        db.recordCreditPurchase(user.id, pkg.credits, amount, razorpay_payment_id, razorpay_order_id);

        const newBalance = db.getUserCredits(user.id);
        console.log(`✅ Credits added: ${pkg.credits} for user ${user.email}. New balance: ${newBalance}`);

        // Track Purchase
        const { ip, userAgent, fbp, fbc } = getClientInfo(req);
        // Calculate amount in major currency unit (dollars/rupees, not cents/paise)
        const isUsd = (currency === 'USD');
        const purchaseAmount = isUsd ? (pkg.amount_usd / 100) : (pkg.amount_inr / 100);

        fb.trackPurchase(
            req.user.email,
            purchaseAmount,
            currency || 'INR',
            razorpay_order_id,
            ip, userAgent, fbp, fbc
        ).catch(e => console.error(e));

        res.json({
            success: true,
            credits_added: pkg.credits,
            new_balance: newBalance
        });
    } catch (error) {
        console.error('❌ Verify credit payment error:', error.message);
        res.status(500).json({ error: 'Failed to verify payment' });
    }
});

// ============ Plan Subscription API ============

// Get user plan info
app.get('/api/plan/info', auth.requireAuth, (req, res) => {
    try {
        const userPlan = db.getUserPlan(req.user.userId);
        const planConfig = getPlanConfig(userPlan.plan);
        res.json({
            plan: userPlan.plan || 'free',
            billing_cycle: userPlan.billing_cycle || 'monthly',
            plan_expires_at: userPlan.plan_expires_at,
            monthly_gen_count: userPlan.monthly_gen_count || 0,
            monthly_ugc_count: userPlan.monthly_ugc_count || 0,
            limits: planConfig
        });
    } catch (error) {
        console.error('❌ Get plan info error:', error.message);
        res.status(500).json({ error: 'Failed to get plan info' });
    }
});

// Get available plans
app.get('/api/plan/pricing', (req, res) => {
    res.json({ plans: PLANS, prices: PLAN_PRICES });
});

// Create order for plan subscription
app.post('/api/plan/subscribe', auth.requireAuth, async (req, res) => {
    try {
        if (!razorpay) {
            return res.status(500).json({ error: 'Razorpay not configured' });
        }

        const { planId, billingCycle = 'monthly', currency = 'INR' } = req.body;
        const prices = PLAN_PRICES[planId];

        if (!prices) {
            return res.status(400).json({ error: 'Invalid plan. Choose creator, pro, or agency.' });
        }

        const useCurrency = (currency === 'USD') ? 'USD' : 'INR';
        const priceKey = `${billingCycle}_${useCurrency.toLowerCase()}`;
        const amount = prices[priceKey];

        if (!amount) {
            return res.status(400).json({ error: 'Invalid billing cycle' });
        }

        const order = await razorpay.orders.create({
            amount: amount,
            currency: useCurrency,
            receipt: `plan_${planId}_${Date.now()}`,
            notes: {
                type: 'plan_subscription',
                plan: planId,
                billing_cycle: billingCycle,
                email: req.user.email
            }
        });

        res.json({
            orderId: order.id,
            amount: amount,
            currency: useCurrency,
            key: process.env.RAZORPAY_KEY_ID,
            plan: planId,
            billingCycle: billingCycle
        });
    } catch (error) {
        console.error('❌ Plan subscribe error:', error.message);
        res.status(500).json({ error: 'Failed to create plan order' });
    }
});

// Verify plan payment
app.post('/api/plan/verify', auth.requireAuth, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId, billingCycle = 'monthly' } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing payment details' });
        }

        // Verify signature
        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body)
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ error: 'Invalid payment signature' });
        }

        if (!PLAN_PRICES[planId]) {
            return res.status(400).json({ error: 'Invalid plan' });
        }

        // Activate plan
        const user = db.getUserByEmail(req.user.email);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        db.setUserPlan(user.id, planId, billingCycle);

        // Also initialize upscale credits based on plan
        const planConfig = getPlanConfig(planId);
        db.initUserCredits(user.id);
        db.addCredits(user.id, planConfig.upscale);

        console.log(`✅ Plan activated: ${planId} (${billingCycle}) for ${user.email}`);

        // Track purchase
        const { ip, userAgent, fbp, fbc } = getClientInfo(req);
        const prices = PLAN_PRICES[planId];
        const purchaseAmount = prices[`${billingCycle}_inr`] / 100;
        fb.trackPurchase(req.user.email, purchaseAmount, 'INR', razorpay_order_id, ip, userAgent, fbp, fbc).catch(e => console.error(e));

        res.json({
            success: true,
            plan: planId,
            billing_cycle: billingCycle,
            upscale_credits_added: planConfig.upscale
        });
    } catch (error) {
        console.error('❌ Plan verify error:', error.message);
        res.status(500).json({ error: 'Failed to verify plan payment' });
    }
});

// Paid upscale endpoint (uses credits)
app.post('/api/upscale-esrgan-paid', apiLimiter, auth.requireAuth, async (req, res) => {
    try {
        const { image, scale = 4, face_enhance = false } = req.body;
        const replicateApiKey = process.env.REPLICATE_API_TOKEN;

        if (!image) {
            return res.status(400).json({ error: 'No image provided' });
        }

        if (!replicateApiKey) {
            return res.status(500).json({ error: 'REPLICATE_API_TOKEN not configured on server' });
        }

        // Get user and check credits
        const user = db.getUserByEmail(req.user.email);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const currentCredits = db.getUserCredits(user.id);
        if (currentCredits < 1) {
            return res.status(402).json({
                error: 'Insufficient credits',
                credits: 0,
                required: 1
            });
        }

        // Deduct credit BEFORE processing (atomic)
        const deducted = db.useCredits(user.id, 1);
        if (!deducted) {
            return res.status(402).json({
                error: 'Insufficient credits',
                credits: 0,
                required: 1
            });
        }

        // Validate scale (2, 4, or 8)
        const validScales = [2, 4, 8];
        const upscaleScale = validScales.includes(scale) ? scale : 4;
        const enableFaceEnhance = Boolean(face_enhance);

        console.log(`🔍 Paid upscale at ${upscaleScale}x for ${user.email} (face_enhance: ${enableFaceEnhance})...`);

        // Call Replicate API
        const response = await fetch('https://api.replicate.com/v1/predictions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${replicateApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                version: 'f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa',
                input: {
                    image: `data:image/png;base64,${image}`,
                    scale: upscaleScale,
                    face_enhance: enableFaceEnhance
                }
            })
        });

        if (!response.ok) {
            // Refund credit on API error
            db.addCredits(user.id, 1);
            const errorData = await response.json();
            throw new Error(errorData.detail || 'Replicate API error');
        }

        const prediction = await response.json();

        // Poll for completion
        let result = prediction;
        let attempts = 0;
        while (result.status !== 'succeeded' && result.status !== 'failed' && attempts < 60) {
            await sleep(2000);
            const pollResponse = await fetch(result.urls.get, {
                headers: { 'Authorization': `Bearer ${replicateApiKey}` }
            });
            result = await pollResponse.json();
            attempts++;
        }

        if (result.status === 'failed') {
            // Refund credit on failure
            db.addCredits(user.id, 1);
            throw new Error(result.error || 'Upscaling failed');
        }

        if (!result.output) {
            // Refund credit if no output
            db.addCredits(user.id, 1);
            throw new Error('No output received from upscaler');
        }

        // Log usage
        db.logUpscaleUsage(user.id, 1, upscaleScale, enableFaceEnhance);

        // Fetch the upscaled image and convert to base64
        const imageResponse = await fetch(result.output);
        const imageBuffer = await imageResponse.arrayBuffer();
        const upscaledBase64 = Buffer.from(imageBuffer).toString('base64');

        const remainingCredits = db.getUserCredits(user.id);
        console.log(`✅ Paid upscale complete (${upscaleScale}x). Credits remaining: ${remainingCredits}`);

        res.json({
            image: upscaledBase64,
            scale: upscaleScale,
            credits_used: 1,
            credits_remaining: remainingCredits
        });

    } catch (error) {
        console.error('❌ Paid Upscale Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 4. Get rate limit status
app.get('/api/rate-limit-status', auth.requireAuth, (req, res) => {
    const apiKey = req.headers['x-api-key'] || DEFAULT_API_KEY;
    const state = requestQueue.get(apiKey);

    if (!state) {
        return res.json({ requestsRemaining: 5, resetIn: 0 });
    }

    const now = Date.now();
    const timeInWindow = now - state.windowStart;
    const resetIn = Math.max(0, 60000 - timeInWindow);
    const requestsRemaining = Math.max(0, 60 - state.requestCount);

    res.json({ requestsRemaining, resetIn: Math.ceil(resetIn / 1000) });
});

// 6. User Stats & History
app.get('/api/user/history', auth.requireAuth, (req, res) => {
    try {
        const history = db.getGenerationHistory(req.user.userId);
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/user/stats', auth.requireAuth, (req, res) => {
    try {
        const stats = db.getUserStats(req.user.userId);
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Upscale Image Route - Uses Gemini to enhance image quality
app.post('/api/upscale-image', apiLimiter, async (req, res) => {
    try {
        const { image } = req.body;
        const apiKey = getApiKey(req);

        if (!image) {
            throw new Error("No image provided for upscaling");
        }

        // Use Gemini to enhance and upscale the image
        const contentsParts = [
            { text: "Enhance and upscale this product image. Improve sharpness, increase detail, fix any artifacts, enhance colors for a more professional commercial look. Output the enhanced high-resolution version." },
            { inlineData: { mimeType: "image/png", data: image } }
        ];

        const data = await callGoogleAPI(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent`,
            {
                contents: [{ parts: contentsParts }],
                generationConfig: {
                    responseModalities: ['TEXT', 'IMAGE']
                }
            },
            apiKey,
            3
        );

        const parts = data.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find(p => p.inlineData);

        if (imagePart) {
            res.json({ image: imagePart.inlineData.data });
        } else {
            throw new Error("Could not upscale image. Try again.");
        }

    } catch (error) {
        console.error("Upscale Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============ Admin Routes ============

// Admin Middleware
const requireAdmin = (req, res, next) => {
    const adminToken = req.headers['x-admin-token'];
    // Simple hardcoded token for this phase. In production, use JWT with role='admin'
    if (adminToken === 'your-admin-secret-token-123') {
        next();
    } else {
        res.status(401).json({ error: "Unauthorized Admin Access" });
    }
};

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    // Hardcoded credentials as per plan
    if (username === 'admin' && password === 'admin123') {
        res.json({ token: 'your-admin-secret-token-123' });
    } else {
        res.status(401).json({ error: "Invalid credentials" });
    }
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
    try {
        const stats = db.getAdminStats();
        res.json(stats);
    } catch (e) {
        console.error("Admin Stats Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// Edit User (email and/or password)
app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { email, password, is_active } = req.body;

        const updates = {};

        if (email) {
            updates.email = email;
        }

        if (password) {
            // Hash the new password
            updates.passwordHash = await auth.hashPassword(password);
        }

        if (is_active !== undefined) {
            updates.is_active = is_active;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }

        const success = db.updateUser(id, updates);
        if (success) {
            res.json({ success: true, message: `User ${id} updated` });
        } else {
            res.status(404).json({ error: "User not found" });
        }
    } catch (e) {
        console.error("Admin Update Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// Delete User
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
    try {
        const { id } = req.params;
        const success = db.deleteUser(id);

        if (success) {
            res.json({ success: true, message: `User ${id} deleted` });
        } else {
            res.status(404).json({ error: "User not found" });
        }
    } catch (e) {
        console.error("Helper Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// Get All Users
app.get('/api/admin/users', requireAdmin, (req, res) => {
    try {
        const users = db.getAllUsers();
        res.json(users);
    } catch (e) {
        console.error("Admin Users Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// Create User (Admin)
app.post('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const { email, password, is_active = true } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required" });
        }

        // Check if email already exists
        if (db.emailExists(email)) {
            return res.status(400).json({ error: "Email already registered" });
        }

        // Hash password
        const passwordHash = await auth.hashPassword(password);

        // Create user with admin-generated payment IDs
        const paymentId = 'admin_' + Date.now();
        const orderId = 'admin_order_' + Date.now();

        db.createUser(email, passwordHash, paymentId, orderId);

        // Get the created user
        const user = db.getUserByEmail(email);

        // Set active status if specified
        if (user && !is_active) {
            db.updateUser(user.id, { is_active: false });
        }

        res.json({
            success: true,
            message: `User ${email} created successfully`,
            user: { id: user?.id, email }
        });
    } catch (e) {
        console.error("Admin Create User Error:", e);
        res.status(500).json({ error: e.message });
    }
});


// ============ Test Data Seeding ============
app.post('/api/test/seed', async (req, res) => {
    try {
        const testEmail = 'test@example.com';
        if (!db.emailExists(testEmail)) {
            // Password: password123
            const hash = await auth.hashPassword('password123');
            // Mock payment/order IDs
            db.createUser(testEmail, hash, 'pay_test_123', 'order_test_123');
            res.json({ message: "Test user created: test@example.com / password123", email: testEmail });
        } else {
            res.json({ message: "Test user already exists", email: testEmail });
        }
    } catch (e) {
        console.error("Seed Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// ============ AUTHENTICATION ROUTES ============

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const result = await auth.loginUser(email, password);
        res.json(result);
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
});

// Verify Token
app.post('/api/auth/verify', (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.json({ valid: false, message: 'No token provided' });
        }

        const decoded = auth.verifyToken(token);
        if (decoded) {
            // Check if user has paid (has a Razorpay payment ID)
            const user = db.getUserByEmail(decoded.email);
            const isPaid = !!(user && user.razorpay_payment_id);
            const userPlan = db.getUserPlan(decoded.userId);
            res.json({
                valid: true,
                userId: decoded.userId,
                email: decoded.email,
                isPaid,
                plan: userPlan.plan || 'free',
                planConfig: getPlanConfig(userPlan.plan),
                monthly_gen_count: userPlan.monthly_gen_count || 0,
                monthly_ugc_count: userPlan.monthly_ugc_count || 0
            });
        } else {
            res.json({ valid: false, message: 'Invalid or expired token' });
        }
    } catch (error) {
        res.json({ valid: false, message: error.message });
    }
});

// Google OAuth Login (for existing paid users only)
const { OAuth2Client } = require('google-auth-library');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Signup Endpoint (Freemium)
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        // Register user
        await auth.registerFreeUser(email, password);

        // Auto-login (generate token)
        const user = db.getUserByEmail(email);
        const jwt = require('jsonwebtoken');
        const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        // Track Lead (New Signup)
        const { ip, userAgent, fbp, fbc } = getClientInfo(req);
        fb.trackLead(email, ip, userAgent, fbp, fbc).catch(e => console.error(e));

        res.json({ token, email: user.email });

    } catch (error) {
        console.error('Signup error:', error);
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/auth/google', async (req, res) => {
    try {
        if (!googleClient) {
            return res.status(500).json({ error: 'Google login not configured' });
        }

        const { credential } = req.body;
        if (!credential) {
            return res.status(400).json({ error: 'Missing Google credential' });
        }

        // Verify Google token
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();
        const email = payload.email;

        // Check if user exists
        let user = db.getUserByEmail(email);

        // If no user, create one (Freemium)
        if (!user) {
            // Generate random password for Google users
            const randomPassword = auth.generatePassword();
            await auth.registerFreeUser(email, randomPassword);
            user = db.getUserByEmail(email);

            // Track Lead
            const { ip, userAgent, fbp, fbc } = getClientInfo(req);
            fb.trackLead(email, ip, userAgent, fbp, fbc).catch(e => console.error(e));
        }

        if (!user.is_active) {
            return res.status(403).json({ error: 'Account is deactivated' });
        }

        // Generate JWT token
        const jwt = require('jsonwebtoken');
        const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({ token, email: user.email });
    } catch (error) {
        console.error('Google auth error:', error);
        res.status(401).json({ error: 'Google authentication failed' });
    }
});

// Change Password
app.post('/api/auth/change-password', async (req, res) => {
    try {
        const { email, oldPassword, newPassword } = req.body;

        if (!email || !oldPassword || !newPassword) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        await auth.changePassword(email, oldPassword, newPassword);
        res.json({ success: true, message: 'Password updated successfully' });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// ============ PAYMENT ROUTES ============

// Create Razorpay Order
app.post('/api/payment/create-order', async (req, res) => {
    try {
        if (!razorpay) {
            return res.status(500).json({ error: 'Payment system not configured' });
        }

        const { email, amount, currency = 'USD' } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // Check if email already registered
        if (db.emailExists(email)) {
            return res.status(400).json({ error: 'Email already registered. Please login instead.' });
        }

        // Create Razorpay order (amount in smallest currency unit: cents or paise)
        // Default to $47 if no amount provided (safe default for prod)
        const amountValue = amount || 47;
        const amountInSmallestUnit = Math.round(amountValue * 100);

        const order = await razorpay.orders.create({
            amount: amountInSmallestUnit,
            currency: currency,
            receipt: `order_${Date.now()}`,
            notes: { email }
        });

        // Track InitiateCheckout with value for better attribution
        const { ip, userAgent, fbp, fbc } = getClientInfo(req);
        fb.trackInitiateCheckout(email, amountValue, currency, ip, userAgent, fbp, fbc).catch(e => console.error(e));

        // Store pending order with currency
        db.createPendingOrder(order.id, email, amountInSmallestUnit, currency);

        res.json({
            orderId: order.id,
            amount: amountInSmallestUnit,
            currency: currency,
            razorpayKeyId: process.env.RAZORPAY_KEY_ID
        });
    } catch (error) {
        console.error('Create order error:', error);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

// Verify Payment and Create User
app.post('/api/payment/verify', async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing payment details' });
        }

        // Verify signature
        const sign = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSign = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(sign)
            .digest('hex');

        if (razorpay_signature !== expectedSign) {
            return res.status(400).json({ error: 'Invalid payment signature' });
        }

        // Get pending order to retrieve email
        const pendingOrder = db.getPendingOrder(razorpay_order_id);

        if (!pendingOrder) {
            return res.status(400).json({ error: 'Order not found' });
        }

        // Register user with random password
        const credentials = await auth.registerUser(
            pendingOrder.email,
            razorpay_payment_id,
            razorpay_order_id,
            pendingOrder.amount, // Pass amount (in smallest unit)
            pendingOrder.currency // Pass currency
        );

        // Delete pending order
        db.deletePendingOrder(razorpay_order_id);

        // Send credentials email
        await email.sendCredentialsEmail(credentials.email, credentials.password);

        // Track Lead (New User) and Purchase (Lifetime Deal)
        const { ip, userAgent, fbp, fbc } = getClientInfo(req);

        // Track Lead
        fb.trackLead(credentials.email, ip, userAgent, fbp, fbc).catch(e => console.error(e));

        // Track Purchase with correct currency from pending order
        const purchaseAmount = pendingOrder.amount / 100;
        const purchaseCurrency = pendingOrder.currency || 'USD';

        fb.trackPurchase(
            credentials.email,
            purchaseAmount,
            purchaseCurrency,
            razorpay_order_id,
            ip, userAgent, fbp, fbc
        ).catch(e => console.error(e));

        res.json({
            success: true,
            email: credentials.email,
            password: credentials.password,
            message: 'Account created successfully!'
        });
    } catch (error) {
        console.error('Payment verify error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ PASSWORD RESET ROUTES ============

// Request password reset
app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email: userEmail } = req.body;

        if (!userEmail) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // Check if user exists
        const user = db.getUserByEmail(userEmail);
        if (!user) {
            // Don't reveal if email exists or not
            return res.json({ success: true, message: 'If this email exists, a reset link has been sent.' });
        }

        // Generate reset token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

        // Store token
        db.createResetToken(userEmail, resetToken, expiresAt);

        // Send reset email
        const resetUrl = `${process.env.APP_URL || 'http://localhost:3002'}/reset-password.html?token=${resetToken}`;
        await email.sendPasswordResetEmail(userEmail, resetToken, resetUrl);

        res.json({ success: true, message: 'If this email exists, a reset link has been sent.' });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ error: 'Failed to process request' });
    }
});

// Reset password with token
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return res.status(400).json({ error: 'Token and new password are required' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        // Validate token
        const resetToken = db.getValidResetToken(token);
        if (!resetToken) {
            return res.status(400).json({ error: 'Invalid or expired reset link' });
        }

        // Update password
        const passwordHash = await auth.hashPassword(newPassword);
        db.updatePassword(resetToken.email, passwordHash);

        // Mark token as used
        db.markTokenUsed(token);

        res.json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// Video Generation Endpoint (Creator+ plan required)
app.post('/api/video/generate', auth.requireAuth, apiLimiter, async (req, res) => {
    try {
        const user = req.user;
        const { imageUrl, prompt, model, endImageUrl, directorMode } = req.body;

        // Plan gating: Creator+ only for Director/Video
        const userPlan = db.getUserPlan(user.userId);
        const planConfig = getPlanConfig(userPlan.plan);
        if (!planConfig.director) {
            return res.status(403).json({ error: 'Video generation requires Creator plan or higher. Upgrade to unlock!' });
        }

        if (!imageUrl && model !== 'veo') {
            return res.status(400).json({ error: 'Image URL is required' });
        }

        // Route Veo requests to the dedicated Veo handler
        if (model === 'veo') {
            // Veo uses Google Gemini API (user's own key)
            const apiKey = req.body.apiKey || req.headers['x-api-key'] || process.env.GEMINI_API_KEY;
            if (!apiKey) {
                return res.status(403).json({ error: 'Google Veo requires a Gemini API key. Add it in Settings.' });
            }

            try {
                const ai = new GoogleGenAI({ apiKey });
                const generateParams = {
                    model: 'veo-2-generate-001',
                    prompt: prompt || 'Product showcase, cinematic, professional lighting',
                };

                // If image provided, do image-to-video
                if (imageUrl) {
                    // Download the image and convert to base64
                    const imgRes = await fetch(imageUrl);
                    const imgBuffer = await imgRes.buffer();
                    generateParams.image = {
                        imageBytes: imgBuffer.toString('base64'),
                        mimeType: 'image/png',
                    };
                }

                const operation = await ai.models.generateVideos(generateParams);
                console.log(`🎬 Veo generation started for ${user.email}: ${operation.name}`);

                // Increment gen count
                db.incrementGenCount(user.userId);

                res.json({
                    success: true,
                    veoOperation: operation.name,
                    status: 'processing',
                    provider: 'google_veo'
                });
            } catch (veoErr) {
                console.error('Veo generation error:', veoErr);
                res.status(500).json({ error: `Veo error: ${veoErr.message}` });
            }
            return;
        }

        // LTX / Wan models use Replicate
        // Verify credit balance
        let VIDEO_COST = 5;
        const userCredits = await db.getUserCredits(user.userId);
        if (userCredits < VIDEO_COST) {
            return res.status(402).json({ error: 'Insufficient credits', required: VIDEO_COST, current: userCredits });
        }
        await db.useCredits(user.userId, VIDEO_COST);

        const prediction = await replicate.generateVideoFromImage(imageUrl, prompt, model, { endImageUrl, directorMode });
        console.log(`🎬 Video generation started for ${user.email}: ${prediction.id} (Model: ${model || 'wan'}, Mode: ${directorMode || 'standard'})`);

        res.json({
            success: true,
            predictionId: prediction.id,
            status: prediction.status,
            creditsRemaining: userCredits - VIDEO_COST
        });

    } catch (error) {
        console.error('Video generation error:', error);
        res.status(500).json({ error: 'Failed to start video generation' });
    }
});

// Google Veo Status Polling Endpoint
app.get('/api/video/veo-status/:operationName', auth.requireAuth, async (req, res) => {
    try {
        const apiKey = req.query.apiKey || req.headers['x-api-key'] || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(403).json({ error: 'API key required to check Veo status' });
        }

        const ai = new GoogleGenAI({ apiKey });
        const operation = await ai.operations.getVideosOperation({
            operation: { name: req.params.operationName },
        });

        if (operation.done) {
            const video = operation.response?.generatedVideos?.[0];
            if (video && video.video) {
                // Return the video file URI for download
                res.json({
                    status: 'succeeded',
                    done: true,
                    videoUri: video.video.uri,
                    videoMimeType: video.video.mimeType || 'video/mp4'
                });
            } else {
                res.json({ status: 'failed', done: true, error: 'No video generated' });
            }
        } else {
            res.json({ status: 'processing', done: false });
        }
    } catch (error) {
        console.error('Veo status check error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Google Veo Text-to-Video Endpoint (standalone, Creator+ required)
app.post('/api/video/generate-veo', auth.requireAuth, apiLimiter, async (req, res) => {
    try {
        const user = req.user;
        const userPlan = db.getUserPlan(user.userId);
        const planConfig = getPlanConfig(userPlan.plan);

        if (!planConfig.veo) {
            return res.status(403).json({ error: 'Google Veo requires Creator plan or higher.' });
        }

        const { prompt, imageBase64, imageMimeType } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        const apiKey = req.body.apiKey || req.headers['x-api-key'] || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(403).json({ error: 'Gemini API key required for Veo video generation.' });
        }

        const ai = new GoogleGenAI({ apiKey });
        const generateParams = { model: 'veo-2-generate-001', prompt };

        if (imageBase64) {
            generateParams.image = { imageBytes: imageBase64, mimeType: imageMimeType || 'image/png' };
        }

        const operation = await ai.models.generateVideos(generateParams);
        console.log(`🎬 Veo standalone generation for ${user.email}: ${operation.name}`);

        db.incrementGenCount(user.userId);

        res.json({
            success: true,
            veoOperation: operation.name,
            status: 'processing',
            provider: 'google_veo'
        });
    } catch (error) {
        console.error('Veo generate error:', error);
        res.status(500).json({ error: `Veo generation failed: ${error.message}` });
    }
});

// Create Public Gallery Endpoint (No Auth Required)
app.get('/api/ugc/gallery/public', async (req, res) => {
    try {
        // limit to 50 latest public items
        const assets = db.getPublicGallery(50);
        res.json({ assets });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Flux Image Generation Endpoint (Casting)
app.post('/api/image/generate-flux', auth.requireAuth, apiLimiter, async (req, res) => {
    try {
        const user = req.user;
        const { prompt, aspectRatio } = req.body;

        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        // Flux Cost (2 credits)
        const FLUX_COST = 2;
        const userCredits = await db.getUserCredits(user.userId);

        if (userCredits < FLUX_COST) {
            return res.status(402).json({
                error: 'Insufficient credits',
                required: FLUX_COST,
                current: userCredits
            });
        }

        await db.useCredits(user.userId, FLUX_COST);

        const prediction = await replicate.generateImageFlux(prompt, aspectRatio);

        console.log(`🎨 Flux generation started for ${user.email}: ${prediction.id}`);

        res.json({
            success: true,
            predictionId: prediction.id,
            status: prediction.status,
            creditsRemaining: userCredits - FLUX_COST
        });

    } catch (error) {
        console.error('Flux generation error:', error);
        res.status(500).json({ error: 'Failed to start Flux generation' });
    }
});

// Video Status Endpoint
app.get('/api/video/status/:id', auth.requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const prediction = await replicate.getPredictionStatus(id);
        res.json(prediction);
    } catch (error) {
        console.error('Video status error:', error);
        res.status(500).json({ error: 'Failed to check video status' });
    }
});

// ============ UGC NODE ENGINE ROUTES ============

// Generate UGC Script via Gemini
app.post('/api/ugc/generate-script', auth.requireAuth, apiLimiter, async (req, res) => {
    try {
        // Plan gating: Pro+ only
        const userPlan = db.getUserPlan(req.user.userId);
        const planConfig = getPlanConfig(userPlan.plan);
        if (planConfig.ugc <= 0) {
            return res.status(403).json({ error: 'UGC Video Studio requires Pro plan or higher. Upgrade to unlock!' });
        }
        if (userPlan.monthly_ugc_count >= planConfig.ugc) {
            return res.status(429).json({ error: `Monthly UGC limit reached (${planConfig.ugc}). Upgrade for more.` });
        }

        const { productName, industry, keyBenefit } = req.body;

        if (!productName) {
            return res.status(400).json({ error: 'Product name is required' });
        }

        const apiKey = getApiKey(req);

        const systemPrompt = `You are a viral UGC Scriptwriter. You must generate a 3-scene script for a short video ad.
The product is "${productName}" in the "${industry || 'General'}" industry. Key benefit: "${keyBenefit || 'high quality'}".
Output ONLY valid JSON (no markdown, no code fences), with this exact structure:
{
  "scenes": [
    {
      "id": 1,
      "type": "hook",
      "visual_prompt": "Close up of [Character] looking frustrated, touching face, dramatic lighting, cinematic, 8k",
      "voiceover": "Are you tired of [problem]?"
    },
    {
      "id": 2,
      "type": "product_reveal",
      "visual_prompt": "Cinematic shot of ${productName} on a stylish surface, soft lighting, product photography, 8k",
      "voiceover": "That is why I switched to ${productName}."
    },
    {
      "id": 3,
      "type": "testimonial",
      "visual_prompt": "Medium shot of [Character] smiling, holding ${productName} near face, warm lighting, 8k",
      "voiceover": "It changed my life in just one week."
    }
  ]
}
Customize the visual_prompt and voiceover to match the product, industry, and benefit. Be creative and engaging. Keep voiceover text short (under 15 words each).`;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`;
        const data = await callGoogleAPI(
            url,
            {
                contents: [{ parts: [{ text: systemPrompt }] }],
                generationConfig: { temperature: 0.8, maxOutputTokens: 1024 }
            },
            apiKey,
            3
        );

        const textPart = data.candidates?.[0]?.content?.parts?.find(p => p.text);
        if (!textPart) throw new Error('No response from Gemini');

        // Parse JSON from response (strip markdown fences if present)
        let jsonStr = textPart.text.trim();
        jsonStr = jsonStr.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
        const scriptData = JSON.parse(jsonStr);

        res.json(scriptData);
    } catch (error) {
        console.error('UGC script generation error:', error);
        res.status(500).json({ error: error.message || 'Failed to generate script' });
    }
});

// ============ UGC PROJECT ROUTES ============

// Save Project
app.post('/api/ugc/projects', auth.requireAuth, async (req, res) => {
    try {
        const { name, workflow, thumbnail } = req.body;
        const userId = auth.getUserId(req);

        // Check if project exists (update) or new (create)
        // For MVP, we'll just create new or update if ID provided
        // Let's assume create for now, optimization later

        const result = db.createUGCProject(userId, name || 'Untitled Project', JSON.stringify(workflow), thumbnail);
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get User Projects
app.get('/api/ugc/projects', auth.requireAuth, async (req, res) => {
    try {
        const userId = auth.getUserId(req);
        const projects = db.getUserProjects(userId);
        res.json({ projects });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Load Project
app.get('/api/ugc/projects/:id', auth.requireAuth, async (req, res) => {
    try {
        const project = db.getProjectById(req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        // Verify ownership
        // const userId = auth.getUserId(req);
        // if (project.user_id !== userId) return res.status(403).json({ error: 'Unauthorized' });
        res.json(project);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ UGC GALLERY ROUTES ============

// Get User Gallery
app.get('/api/ugc/gallery', auth.requireAuth, async (req, res) => {
    try {
        const userId = auth.getUserId(req);
        const assets = db.getUserGallery(userId);
        res.json({ assets });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ REVISED RENDER ROUTES (Auto-Save) ============

// Render Scene with Face Consistency (InstantID) or Video (Veo)
app.post('/api/ugc/render-scene', auth.requireAuth, apiLimiter, async (req, res) => {
    try {
        const { prompt, faceImage, productImage, faceStrength, model } = req.body;
        const user = req.user;
        const userId = user.userId;

        if (!prompt) {
            return res.status(400).json({ error: 'Scene prompt is required' });
        }

        // --- Veo Video Generation Path ---
        if (model === 'veo') {
            const userPlan = db.getUserPlan(userId);
            const planConfig = getPlanConfig(userPlan.plan);

            if (!planConfig.veo) {
                return res.status(403).json({ error: 'Google Veo requires Pro Founder LTD or higher.' });
            }

            // Check BYOK Limits
            if (planConfig.byok_gen_limit !== Infinity && userPlan.monthly_gen_count >= planConfig.byok_gen_limit) {
                return res.status(403).json({ error: `Monthly BYOK limit reached (${planConfig.byok_gen_limit}). Please upgrade for more.` });
            }

            const apiKey = req.body.apiKey || req.headers['x-api-key'] || process.env.GEMINI_API_KEY;
            if (!apiKey) {
                return res.status(403).json({ error: 'Gemini API key required for Veo generation. Save it in Settings.' });
            }

            const ai = new GoogleGenAI({ apiKey });
            const generateParams = { model: 'veo-2-generate-001', prompt };

            if (productImage || faceImage) {
                // Determine which image to use as the base for video. Product image takes precedence in UGC scenes usually.
                const baseImage = productImage || faceImage;
                // Basic check if it's base64 data URI
                if (baseImage.startsWith('data:image')) {
                    const matches = baseImage.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                    if (matches && matches.length === 3) {
                        generateParams.image = { mimeType: matches[1], imageBytes: matches[2] };
                    }
                }
            }

            const operation = await ai.models.generateVideos(generateParams);
            db.incrementGenerationCount(userId); // Deduct from BYOK limit

            return res.json({ predictionId: operation.name, status: 'starting' });
        }
        // --- End Veo Path ---

        // --- Standard Image Generation Path ---
        // Build enhanced prompt with product placement if product image provided
        let enhancedPrompt = prompt;
        if (productImage) {
            enhancedPrompt += `, holding a product prominently, professional product photography`;
        }

        let prediction;
        // Use Flux as fallback if no face image provided
        if (!faceImage) {
            prediction = await replicate.generateImageFlux(enhancedPrompt, '16:9');
        } else {
            // Use InstantID for face-consistent generation
            prediction = await replicate.generateSceneWithFace(faceImage, enhancedPrompt, {
                faceStrength: faceStrength || 0.8
            });
        }

        // For simplicity in MVP: Client will call POST /api/ugc/gallery/add after successful poll.
        res.json({ predictionId: prediction.id, status: prediction.status });
    } catch (error) {
        console.error('UGC scene/video render error:', error);
        res.status(500).json({ error: error.message || 'Failed to render scene/video' });
    }
});

// Add Asset to Gallery (called by client after successful generation/upload)
app.post('/api/ugc/gallery/add', auth.requireAuth, async (req, res) => {
    try {
        const { type, url, prompt, projectId } = req.body;
        const userId = auth.getUserId(req);
        db.addToGallery(userId, projectId || null, type, url, prompt);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Poll Scene/Video Render Status
app.get('/api/ugc/render-scene/status/:id', auth.requireAuth, async (req, res) => {
    try {
        const id = decodeURIComponent(req.params.id);

        // If it's a Google Veo Operation ID
        if (id.startsWith('projects/') || id.startsWith('operations/')) {
            const apiKey = req.query.apiKey || req.headers['x-api-key'] || process.env.GEMINI_API_KEY;
            if (!apiKey) return res.status(403).json({ error: 'API key required for Veo status' });

            const ai = new GoogleGenAI({ apiKey });
            const operation = await ai.operations.getVideosOperation({ name: id });

            if (operation.done) {
                if (operation.response && operation.response.generatedVideos && operation.response.generatedVideos.length > 0) {
                    const videoUrl = operation.response.generatedVideos[0].video.uri;
                    return res.json({ status: 'succeeded', output: videoUrl });
                } else if (operation.error) {
                    return res.json({ status: 'failed', error: operation.error.message || 'Unknown Veo error' });
                } else {
                    return res.json({ status: 'failed', error: 'No video output returned by Veo' });
                }
            } else {
                return res.json({ status: 'processing', done: false });
            }
        }

        // Standard Replicate (InstantID/Flux) Polling
        const status = await replicate.getPredictionStatus(id);
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Redirect root to landing page if not authenticated
app.get('/', (req, res) => {
    res.redirect('/landing.html');
});

// Run founder migration on startup (idempotent)
db.migrateFounders();

if (require.main === module) {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
module.exports = app;



