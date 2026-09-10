// Load environment before requiring anything that reads process.env at import time.
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const emailService = require('./lib/email');
const { isEmailConfigured } = require('./lib/email');
const uuidv4 = () => crypto.randomUUID();
const helmet = require('helmet');
const compression = require('compression');
const Sentry = require('@sentry/node');

// Initialize Sentry before anything else
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        integrations: [],
        environment: process.env.NODE_ENV || 'development',
        release: process.env.npm_package_version || '1.0.0',
        tracesSampleRate: 1.0, 
        profilesSampleRate: 1.0,
    });
    console.log("Sentry initialized.");
}

const { requireLoginRateLimit, requireApiRateLimit, requireGenerateRateLimit, requireEmailVerifyRateLimit, rateLimitingEnabled } = require('./lib/ratelimit');

// Import auth and database modules
const auth = require('./auth');
const db = require('./database');
const email = require('./email');
const fb = require('./services/facebook');
const replicate = require('./services/replicate');
const cookieParser = require('cookie-parser');
const { GoogleGenAI } = require('@google/genai');

// V2 Services
const WorkspaceService = require('./lib/workspace_service');
const ProductService = require('./lib/product_service');
const OutputService = require('./lib/output_service');
const JobRegistry = require('./lib/job_registry');
const PhotographyEngine = require('./lib/engines/photography');
const CommerceEngine = require('./lib/engines/commerce');
const BlueprintEngine = require('./lib/engines/blueprint');
const ProductionEngine = require('./lib/engines/production');
const { supabaseAdmin, isSupabaseConfigured } = require('./lib/supabase');
const { getJwtSecret } = require('./lib/jwtSecret');
const UsageRecorder = require('./lib/usage_recorder');
const { getUserProviderKey } = require('./lib/userKeys');
const jwt = require('jsonwebtoken');

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

// The request handler must be the first middleware on the app
if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
}

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

// Rate Limits
app.use(requireApiRateLimit);

// Deployment diagnostic. Reports which required env vars are present so a
// misconfigured deploy is visible immediately instead of surfacing as a 500 on
// every route. Never returns values, only presence.
app.get('/api/health', (req, res) => {
    const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET', 'KEY_ENCRYPTION_SECRET'];
    const optional = ['GEMINI_API_KEY', 'REPLICATE_API_TOKEN', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'];
    const missing = required.filter((k) => !process.env[k]);

    res.status(missing.length ? 503 : 200).json({
        status: missing.length ? 'misconfigured' : 'ok',
        missingRequiredEnv: missing,
        presentOptionalEnv: optional.filter((k) => !!process.env[k]),
        supabaseConfigured: isSupabaseConfigured,
        rateLimitingEnabled: rateLimitingEnabled,
        // Without this, signup completes but no verification mail is sent, and
        // requireVerifiedUser then blocks generation for every new account.
        emailConfigured: isEmailConfigured(),
        nodeEnv: process.env.NODE_ENV || 'development'
    });
});



// ==========================================
// COMPOSABLE MIDDLEWARES
// ==========================================
const requireVerifiedUser = (req, res, next) => {
    if (!req.user.verified) {
        return res.status(403).json({ error: 'Email verification required to perform this action.' });
    }
    next();
};

const requireCredits = async (req, res, next) => {
    // Only applies to non-free operations or we let the engines reserve exact amounts.
    // This is a top-level gate to prevent spam if balance is <= 0
    try {
        const balance = await db.getUserCredits(req.user.userId);
        if (balance <= 0) {
            return res.status(402).json({ error: 'Insufficient credits.' });
        }
        next();
    } catch (e) {
        return res.status(500).json({ error: 'Failed to verify credits' });
    }
};

// ==========================================
// SPRINT 1: RAZORPAY WEBHOOK (Idempotent)
// ==========================================
// NOTE: express.raw() is required to verify the raw payload signature
app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['x-razorpay-signature'];
        if (!signature) return res.status(400).send('Missing signature');

        // Verify webhook signature using the raw body buffer
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET)
            .update(req.body)
            .digest('hex');

        if (expectedSignature !== signature) {
            console.error('❌ Invalid webhook signature');
            return res.status(400).send('Invalid signature');
        }

        const payload = JSON.parse(req.body.toString());
        console.log('✅ Razorpay Webhook Received:', payload.event);

        const { supabaseAdmin } = require('./lib/supabase');
        
        // Log webhook event
        try {
            await supabaseAdmin.from('webhook_events').insert({
                event_id: payload.event,
                payload: payload
            });
        } catch (e) {
            console.error('Failed to log webhook event (may already exist or schema missing):', e.message);
        }

        if (payload.event === 'payment.captured' || payload.event === 'order.paid') {
            const payment = payload.payload.payment.entity;
            const orderId = payment.order_id;
            const paymentId = payment.id;
            
            const notes = payment.notes || {};
            const userId = notes.userId;
            const creditsToGrant = parseInt(notes.credits, 10);
            
            if (!userId || !creditsToGrant) {
                console.warn('⚠️ Webhook missing userId or credits in notes, skipping.');
                return res.status(200).send('Skipped: No user data in notes');
            }

            // Check Idempotency (has this payment already been processed?)
            const { data: existingTx } = await supabaseAdmin.from('credit_transactions')
                .select('id')
                .eq('reference_id', paymentId)
                .maybeSingle();

            if (existingTx) {
                console.log('🔄 Payment already processed, skipping:', paymentId);
                return res.status(200).send('Already processed');
            }

            // Grant credits via ledger (append-only)
            await db.recordCreditPurchase(userId, creditsToGrant, payment.amount / 100, paymentId, orderId);
            await db.recordPayment({
                paymentId, orderId, userId,
                kind: 'credits', credits: creditsToGrant,
                amount: payment.amount, currency: payment.currency || 'INR'
            });
            console.log(`✅ Successfully granted ${creditsToGrant} credits to user ${userId} via Webhook`);
            
            // Mark processed
            try {
                await supabaseAdmin.from('webhook_events')
                    .update({ processed: true, processed_at: new Date().toISOString() })
                    .eq('event_id', payload.event);
            } catch (e) {}
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        
        // Attempt to log error if payload exists
        try {
            const payload = JSON.parse(req.body.toString());
            const { supabaseAdmin } = require('./lib/supabase');
            await supabaseAdmin.from('webhook_events')
                .update({ error: error.message })
                .eq('event_id', payload.event);
        } catch (e) {}

        // Do not return 500 otherwise Razorpay will endlessly retry
        res.status(200).send('Error but acknowledged'); 
    }
});


app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ==========================================
// AUTH ENDPOINTS
// ==========================================
app.get('/api/auth/verify-email', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).send('Missing token');
        
        const success = await db.verifyEmailToken(token);
        if (success) {
            // Redirect to dashboard with success message
            res.redirect('/dashboard.html?verified=true');
        } else {
            res.status(400).send('Invalid or expired verification link.');
        }
    } catch (e) {
        res.status(500).send('Error verifying email.');
    }
});

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
app.post('/api/generate-text', auth.requireAuth, requireVerifiedUser, requireGenerateRateLimit, async (req, res) => {
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
// V2 Workspace API
app.get('/api/workspace', auth.requireAuth, async (req, res) => {
    try {
        const workspace = await WorkspaceService.getOrCreateWorkspace(req.user.userId);
        res.json(workspace);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// V2 Products API
app.get('/api/products', auth.requireAuth, async (req, res) => {
    try {
        const workspace = await WorkspaceService.getOrCreateWorkspace(req.user.userId);
        const products = await ProductService.getProductsForWorkspace(workspace.id);
        res.json(products);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/products', auth.requireAuth, async (req, res) => {
    try {
        const { name, category, base64Image } = req.body;
        if (!name || !base64Image) {
            return res.status(400).json({ error: 'Name and image are required.' });
        }

        const workspace = await WorkspaceService.getOrCreateWorkspace(req.user.userId);

        // 1. Create Product (Primary Output ID null for now)
        const product = await ProductService.createProduct(workspace.id, { name, category });

        // 2. Upload Image to Supabase
        const buffer = Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ""), 'base64');
        const filename = `${req.user.userId}/${product.id}_initial.jpg`;
        const { error: storageError } = await supabaseAdmin.storage.from('product-images').upload(filename, buffer, { contentType: 'image/jpeg', upsert: true });
        
        if (storageError) throw new Error(`Storage upload failed: ${storageError.message}`);
        const { data: publicUrlData } = supabaseAdmin.storage.from('product-images').getPublicUrl(filename);

        // 3. Create Output Collection
        const collection = await OutputService.createCollection(product.id, 'initial_upload', { type: 'manual_upload' });
        await OutputService.updateCollectionStatus(collection.id, 'completed');

        // 4. Create Output
        const output = await OutputService.createOutput(product.id, collection.id, {
            engine: 'manual',
            format: 'original',
            storage_path: publicUrlData.publicUrl
        });

        // 5. Link Primary Output
        const updatedProduct = await ProductService.updateProduct(product.id, { primary_output_id: output.id });

        res.json(updatedProduct);
    } catch (error) {
        console.error('Error creating product:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/products/:id', auth.requireAuth, async (req, res) => {
    try {
        const product = await ProductService.getProductById(req.params.id);
        const workspace = await WorkspaceService.getOrCreateWorkspace(req.user.userId);
        if (product.workspace_id !== workspace.id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        res.json(product);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/products/:id', auth.requireAuth, async (req, res) => {
    try {
        const product = await ProductService.getProductById(req.params.id);
        const workspace = await WorkspaceService.getOrCreateWorkspace(req.user.userId);
        if (product.workspace_id !== workspace.id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }
        
        const updatedProduct = await ProductService.updateProduct(req.params.id, req.body);
        res.json(updatedProduct);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/generate-image', auth.requireAuth, requireVerifiedUser, requireGenerateRateLimit, async (req, res) => {
    try {
        const { prompt, images, mode, modelEthnicity, modelGender } = req.body;
        const userId = req.user.userId;

        // Plan-based API key resolution
        const userPlan = await db.getUserPlan(userId);
        const planConfig = getPlanConfig(userPlan.plan);
        let apiKey;

        // Universal BYOK: all plans can use own key for higher limits
        // A key saved in the vault counts as BYOK just as much as one sent on
        // the request, so a user who saved theirs is not pushed onto the
        // platform key (and its tighter free-tier limit) for every call.
        const userKey = req.body.apiKey || req.headers['x-api-key']
            || await getUserProviderKey(req.user?.userId, 'gemini');

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
            const creditInfo = await db.getUserCreditInfo(userId);
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
            await db.logGeneration(userId, 'google', 'gemini-2.5-flash-image', 0, 0, 0.005, 1, 0, 'success', null, null, null, null);
            // Increment monthly gen count for paid plans
            if (planConfig.type === 'server' && userPlan.plan !== 'lifetime_founder') {
                await db.incrementGenCount(userId);
                await UsageRecorder.record({
                    userId, job: 'generate_image', model: 'gemini-image',
                    fundedBy: userKey ? 'byok' : 'platform'
                });
            }
            // Deduct credit for founder plan
            if (userPlan.plan === 'lifetime_founder') {
                await db.useCredits(userId, 1);
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
app.post('/api/upscale-esrgan', auth.requireAuth, requireVerifiedUser, requireGenerateRateLimit, async (req, res) => {
    try {
        const { image, scale = 4, face_enhance = false } = req.body;
        const replicateApiKey = process.env.REPLICATE_API_TOKEN;

        // Plan gating: Creator+ only
        const userPlan = await db.getUserPlan(req.user.userId);
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
            await UsageRecorder.record({
                userId: req.user.userId, job: 'upscale', model: 'esrgan',
                fundedBy: 'platform', status: 'failed', error: 'no output from upscaler'
            });
            throw new Error('No output received from upscaler');
        }

        // Fetch the upscaled image and convert to base64
        const imageResponse = await fetch(result.output);
        const imageBuffer = await imageResponse.arrayBuffer();
        const upscaledBase64 = Buffer.from(imageBuffer).toString('base64');

        console.log(`✅ Upscaling complete (${upscaleScale}x)`);

        await UsageRecorder.record({
            userId: req.user.userId, job: 'upscale', model: 'esrgan', fundedBy: 'platform'
        });

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
    // Infinity here meant the `monthly_gen_count >= byok_gen_limit` guards never
    // fired, so runaway use had no signal. A high finite ceiling behaves the
    // same for real customers and still trips on abuse.
    agency_ltd: { gen_limit: 0, byok_gen_limit: 25000, upscale: 200, ugc: 50, director: true, veo: true, requires_byok: true, watermark: false, templates: 'advanced', bulk: true, commercial: true },
    // Was the only plan with requires_byok: false and gen_limit: Infinity —
    // unlimited generation on the platform's own key, for a single payment.
    // Existing holders keep the plan; it is no longer an open tap.
    lifetime_founder: { gen_limit: 0, byok_gen_limit: 25000, upscale: 999, ugc: 50, director: true, veo: true, requires_byok: true, watermark: false, templates: 'advanced', bulk: true, commercial: true }
};

// Backward-compat: map legacy plan names to new ones
const PLAN_ALIASES = { free: 'free_explorer', creator: 'hobbyist_ltd', pro: 'pro_founder_ltd', agency: 'agency_ltd' };

const PLAN_PRICES = {
    hobbyist_ltd: { onetime_usd: 4900 },  // $49
    pro_founder_ltd: { onetime_usd: 9700 },  // $97
    agency_ltd: { onetime_usd: 19700 }   // $197
};

// Veo is roughly an order of magnitude more expensive per clip than anything
// else the product generates, and neither Veo route charged credits. Falling
// back to process.env.GEMINI_API_KEY therefore meant a one-time plan purchase
// bought unlimited Veo video on the platform's key. Veo is BYOK only: the
// caller supplies a key or gets a 402.
async function resolveVeoKey(req) {
    const fromRequest = req.body?.apiKey || req.headers['x-api-key'];
    if (fromRequest) return fromRequest;
    // Fall back to the key the user saved in the encrypted vault. Never falls
    // back to a platform key — Veo is customer-funded.
    return await getUserProviderKey(req.user?.userId, 'gemini');
}

const VEO_KEY_REQUIRED = {
    error: 'Veo video generation requires your own Gemini API key. Add one in Settings.',
    code: 'BYOK_REQUIRED'
};

// Turn a provider failure into something the caller can act on. A 401 means
// the platform's own key is wrong, a 402 means the provider account needs
// billing -- both are configuration problems, and returning "Failed to start
// generation" for either sends people looking in the wrong place.
function providerFailure(res, error, engine) {
    const status = error && error.providerStatus;
    if (status === 401 || status === 403) {
        console.error(`[config] ${engine}: provider rejected the platform API token.`);
        return res.status(503).json({
            error: `${engine} is not available: the provider rejected our API token.`,
            code: 'PROVIDER_AUTH'
        });
    }
    if (status === 402) {
        console.error(`[config] ${engine}: provider requires billing on the platform account.`);
        return res.status(503).json({
            error: `${engine} is not available: the provider account needs billing set up.`,
            code: 'PROVIDER_BILLING'
        });
    }
    console.error(`${engine} generation error:`, error);
    return res.status(502).json({
        error: `${engine} generation failed.`,
        code: 'PROVIDER_ERROR',
        detail: error && error.providerDetail ? String(error.providerDetail).slice(0, 200) : undefined
    });
}

// Helper: Check plan access
function getPlanConfig(planName) {
    const resolved = PLAN_ALIASES[planName] || planName;
    return PLANS[resolved] || PLANS.free_explorer;
}

// Get credit balance
app.get('/api/credits/balance', auth.requireAuth, async (req, res) => {
    try {
        const user = await db.getUserByEmail(req.user.email);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const creditInfo = await db.getUserCreditInfo(user.id);
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
app.get('/api/credits/packages', async (req, res) => {
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

        // Get user for their ID
        const user = await db.getUserByEmail(req.user.email);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const order = await razorpay.orders.create({
            amount: amount,
            currency: useCurrency,
            receipt: `credit_${Date.now()}`,
            notes: {
                type: 'credit_purchase',
                package: packageId,
                credits: pkg.credits,
                email: req.user.email,
                userId: user.id
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
        const user = await db.getUserByEmail(req.user.email);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Determine amount logged
        const useCurrency = (currency === 'USD') ? 'USD' : 'INR';
        const amount = (useCurrency === 'USD') ? pkg.amount_usd : pkg.amount_inr;

        // Add credits and record purchase
        await db.addCredits(user.id, pkg.credits);
        await db.recordCreditPurchase(user.id, pkg.credits, amount, razorpay_payment_id, razorpay_order_id);
        await db.recordPayment({
            paymentId: razorpay_payment_id, orderId: razorpay_order_id,
            userId: user.id, email: user.email,
            kind: 'credits', credits: pkg.credits, amount, currency: useCurrency
        });

        const newBalance = await db.getUserCredits(user.id);
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
app.get('/api/plan/info', auth.requireAuth, async (req, res) => {
    try {
        const userPlan = await db.getUserPlan(req.user.userId);
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
app.get('/api/plan/pricing', async (req, res) => {
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
        const user = await db.getUserByEmail(req.user.email);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        await db.setUserPlan(user.id, planId, billingCycle);

        // Also initialize upscale credits based on plan
        const planConfig = getPlanConfig(planId);
        await db.initUserCredits(user.id);
        await db.addCredits(user.id, planConfig.upscale);

        const planPrice = PLAN_PRICES[planId] || {};
        await db.recordPayment({
            paymentId: razorpay_payment_id, orderId: razorpay_order_id,
            userId: user.id, email: user.email,
            kind: 'plan', planId,
            amount: planPrice.onetime_usd || planPrice[`${billingCycle}_inr`] || 0,
            currency: planPrice.onetime_usd ? 'USD' : 'INR'
        });

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
app.post('/api/upscale-esrgan-paid', auth.requireAuth, requireVerifiedUser, requireGenerateRateLimit, async (req, res) => {
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
        const user = await db.getUserByEmail(req.user.email);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const currentCredits = await db.getUserCredits(user.id);
        if (currentCredits < 1) {
            return res.status(402).json({
                error: 'Insufficient credits',
                credits: 0,
                required: 1
            });
        }

        // Deduct credit BEFORE processing (atomic)
        const deducted = await db.useCredits(user.id, 1);
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
            await db.addCredits(user.id, 1);
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
            await db.addCredits(user.id, 1);
            throw new Error(result.error || 'Upscaling failed');
        }

        if (!result.output) {
            // Refund credit if no output
            await db.addCredits(user.id, 1);
            throw new Error('No output received from upscaler');
        }

        // Log usage
        await db.logUpscaleUsage(user.id, 1, upscaleScale, enableFaceEnhance);
        await UsageRecorder.record({
            userId: user.id, job: 'upscale_paid', model: 'esrgan', fundedBy: 'platform'
        });

        // Fetch the upscaled image and convert to base64
        const imageResponse = await fetch(result.output);
        const imageBuffer = await imageResponse.arrayBuffer();
        const upscaledBase64 = Buffer.from(imageBuffer).toString('base64');

        const remainingCredits = await db.getUserCredits(user.id);
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
app.get('/api/rate-limit-status', auth.requireAuth, async (req, res) => {
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
app.get('/api/user/history', auth.requireAuth, async (req, res) => {
    try {
        const history = await db.getGenerationHistory(req.user.userId);
        res.json(history);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/user/stats', auth.requireAuth, async (req, res) => {
    try {
        const stats = await db.getUserStats(req.user.userId);
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Upscale Image Route - Uses Gemini to enhance image quality
app.post('/api/upscale-image', requireGenerateRateLimit, async (req, res) => {
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
//
// This used to accept a hardcoded x-admin-token, handed out by an admin/admin123
// login. Both strings were committed to this repository and gate user edit and
// delete. Admin is now a claim on the ordinary session JWT, backed by
// users.is_admin, so there is no second credential to leak.
const requireAdmin = async (req, res, next) => {
    try {
        const token = (req.headers.authorization || '').replace(/^Bearer /i, '')
            || (req.cookies && req.cookies.session);
        if (!token) return res.status(401).json({ error: 'Unauthorized Admin Access' });

        const decoded = jwt.verify(token, getJwtSecret());
        const user = await db.getUserById(decoded.userId || decoded.sub);
        if (!user || !user.is_admin || !user.is_active) {
            return res.status(403).json({ error: 'Admin privileges required' });
        }

        req.adminUser = user;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Unauthorized Admin Access' });
    }
};

// Admins sign in through the normal login route; this reports whether the
// current session carries admin rights so the dashboard can route accordingly.
app.get('/api/admin/session', requireAdmin, (req, res) => {
    res.json({ admin: true, email: req.adminUser.email });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const stats = await db.getAdminStats();
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

        const success = await db.updateUser(id, updates);
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
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const success = await db.deleteUser(id);

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
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const users = await db.getAllUsers();
        res.json(users);
    } catch (e) {
        console.error("Admin Users Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// Create User (Admin)

// ==========================================
// SPRINT 1: ADMIN METRICS DASHBOARD
// ==========================================
app.get('/api/admin/metrics', requireAdmin, async (req, res) => {
    try {
        const { supabaseAdmin } = require('./lib/supabase');
        
        // --- 1. Revenue & Customers ---
        // (Mocking financials based on users for now, or querying real data)
        const { count: activeUsers } = await supabaseAdmin.from('users').select('*', { count: 'exact', head: true });
        
        // --- 2. Products & Production ---
        const { data: workspaces } = await supabaseAdmin.from('workspaces').select('id');
        const workspaceIds = workspaces?.map(w => w.id) || [];
        
        let activeProducts = 0;
        let photographyReady = 0;
        let marketplaceReady = 0;
        let advertisingReady = 0;
        
        if (workspaceIds.length > 0) {
            const { data: products } = await supabaseAdmin.from('products').select('id, status');
            activeProducts = products?.length || 0;
            
            // Query output_collections to figure out completion rates
            const { data: collections } = await supabaseAdmin.from('output_collections').select('product_id, engine, status');
            if (collections) {
                const productEngines = {};
                collections.forEach(c => {
                    if (c.status === 'completed') {
                        if (!productEngines[c.product_id]) productEngines[c.product_id] = new Set();
                        productEngines[c.product_id].add(c.engine);
                    }
                });
                
                Object.values(productEngines).forEach(engines => {
                    if (engines.has('photography')) photographyReady++;
                    if (engines.has('commerce')) marketplaceReady++;
                    if (engines.has('campaign_blueprint')) advertisingReady++;
                });
            }
        }
        
        // --- 3. Money ---------------------------------------------------
        // These were hardcoded ("$29.00", "82%") with a comment saying they
        // were mocked for the prototype, which meant the dashboard reported a
        // healthy margin regardless of what the business was actually doing.
        const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0);

        const [allPayments, todayPayments, runs] = await Promise.all([
            db.getRevenue(),
            db.getRevenue(startOfToday.toISOString()),
            supabaseAdmin.from('ai_runs')
                .select('provider_cost, storage_cost, platform_cost, status, started_at, completed_at, funded_by, job')
        ]);

        // Payment amounts are in the smallest unit of their own currency, so
        // they cannot simply be summed. Report per-currency totals.
        const sumByCurrency = (rows) => rows.reduce((acc, p) => {
            acc[p.currency] = (acc[p.currency] || 0) + p.amount;
            return acc;
        }, {});

        const runRows = runs.data || [];
        const costOf = (r) => Number(r.provider_cost || 0) + Number(r.storage_cost || 0) + Number(r.platform_cost || 0);
        const aiCost = runRows.reduce((sum, r) => sum + costOf(r), 0);

        // Coverage is only meaningful over platform-funded runs. A BYOK run
        // costs the platform nothing by design, so counting it as
        // "uninstrumented" because its cost is zero would understate coverage
        // and make the number unreadable.
        const platformRuns = runRows.filter((r) => (r.funded_by || 'platform') === 'platform');
        const byokRuns = runRows.length - platformRuns.length;
        const instrumentedRuns = platformRuns.filter((r) => costOf(r) > 0).length;

        // Margin is only meaningful when both sides are known and in one
        // currency. USD-denominated plan sales are the comparable figure;
        // anything else returns null rather than an invented percentage.
        const usdRevenue = (sumByCurrency(allPayments).USD || 0) / 100;
        const grossMargin = usdRevenue > 0
            ? `${(((usdRevenue - aiCost) / usdRevenue) * 100).toFixed(1)}%`
            : null;

        const completed = runRows.filter((r) => r.status === 'completed');
        const durations = completed
            .filter((r) => r.started_at && r.completed_at)
            .map((r) => (new Date(r.completed_at) - new Date(r.started_at)) / 60000);
        const avgMinutes = durations.length
            ? (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1)
            : null;

        const timeSaved = (marketplaceReady * 4.2 + photographyReady * 2.5).toFixed(1);

        res.json({
            revenue: {
                today: sumByCurrency(todayPayments),
                allTime: sumByCurrency(allPayments),
                aiCost: Number(aiCost.toFixed(4)),
                grossMargin,
                // How much of the AI spend is actually measured. Until this
                // reaches 100%, aiCost and grossMargin are lower bounds:
                // video, upscale and flux do not yet record their cost.
                costCoverage: platformRuns.length
                    ? `${((instrumentedRuns / platformRuns.length) * 100).toFixed(0)}%`
                    : null,
                platformFundedRuns: platformRuns.length,
                customerFundedRuns: byokRuns
            },
            customers: {
                activeUsers: activeUsers || 0,
                activeProducts,
                payingUsers: new Set(allPayments.map((p) => p.user_id).filter(Boolean)).size
            },
            production: {
                runs: runRows.length,
                completed: completed.length,
                failed: runRows.filter((r) => r.status === 'failed').length,
                successRate: runRows.length
                    ? `${((completed.length / runRows.length) * 100).toFixed(1)}%`
                    : null,
                avgMinutes,
                // Cost per platform-funded generation. Dividing by all runs
                // would dilute this with BYOK work the platform never paid for.
                avgCost: platformRuns.length
                    ? Number((aiCost / platformRuns.length).toFixed(4))
                    : null
            },
            progress: {
                photographyReady,
                marketplaceReady,
                blueprintReady: advertisingReady
            },
            outcomes: {
                campaignsProduced: marketplaceReady,
                estimatedHoursSaved: Number(timeSaved)
            }
        });
    } catch (error) {
        console.error('Admin metrics error:', error);
        res.status(500).json({ error: 'Failed to load metrics' });
    }
});


app.post('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const { email, password, is_active = true } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required" });
        }

        // Check if email already exists
        if (await db.emailExists(email)) {
            return res.status(400).json({ error: "Email already registered" });
        }

        // Hash password
        const passwordHash = await auth.hashPassword(password);

        // Create user with admin-generated payment IDs
        const paymentId = 'admin_' + Date.now();
        const orderId = 'admin_order_' + Date.now();

        await db.createUser(email, passwordHash, paymentId, orderId);

        // Get the created user
        const user = await db.getUserByEmail(email);

        // Set active status if specified
        if (user && !is_active) {
            await db.updateUser(user.id, { is_active: false });
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
        if (!await db.emailExists(testEmail)) {
            // Password: password123
            const hash = await auth.hashPassword('password123');
            // Mock payment/order IDs
            await db.createUser(testEmail, hash, 'pay_test_123', 'order_test_123');
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
app.post('/api/auth/login', requireLoginRateLimit, async (req, res) => {
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
app.post('/api/auth/verify', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            return res.json({ valid: false, message: 'No token provided' });
        }

        const decoded = auth.verifyToken(token);
        if (decoded) {
            // Check if user has paid (has a Razorpay payment ID)
            const user = await db.getUserByEmail(decoded.email);
            const isPaid = !!(user && user.razorpay_payment_id);
            const userPlan = await db.getUserPlan(decoded.userId);
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


// ==========================================
// SPRINT 1: EMAIL VERIFICATION
// ==========================================
app.get('/api/auth/verify-email', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).send('Missing token');

        // Check if token exists and is valid
        const { supabaseAdmin } = require('./lib/supabase');
        
        // Find token
        const { data: tokenData } = await supabaseAdmin.from('auth_tokens')
            .select('*')
            .eq('token_hash', token)
            .eq('type', 'email_verification')
            .gt('expires_at', new Date().toISOString())
            .maybeSingle();

        if (!tokenData) {
            return res.status(400).send('Invalid or expired token.');
        }

        // Delete token
        await supabaseAdmin.from('auth_tokens').delete().eq('id', tokenData.id);

        res.redirect('/dashboard.html?verified=true');
    } catch (error) {
        console.error('Email verification error:', error);
        res.status(500).send('Verification failed.');
    }
});

app.post('/api/auth/resend-verification', requireEmailVerifyRateLimit, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }
        
        const { supabaseAdmin } = require('./lib/supabase');
        
        const { data: user } = await supabaseAdmin.from('users').select('id, is_active').eq('email', email).maybeSingle();
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Check if already active/verified
        if (user.is_active) {
            return res.status(400).json({ error: 'Email is already verified' });
        }

        const verificationToken = uuidv4();
        await supabaseAdmin.from('auth_tokens').insert({
            user_id: user.id,
            token_hash: verificationToken,
            type: 'email_verification',
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        });
        
        const verificationLink = `${process.env.APP_URL || 'http://localhost:3000'}/api/auth/verify-email?token=${verificationToken}`;
        await emailService.sendVerificationEmail(email, verificationLink);

        res.json({ success: true, message: 'Verification email sent' });
    } catch (error) {
        console.error('Resend verification email error:', error);
        res.status(500).json({ error: 'Failed to resend verification email' });
    }
});


// Signup Endpoint (Freemium)
app.post('/api/auth/signup', requireLoginRateLimit, async (req, res) => {
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
        const user = await db.getUserByEmail(email);
        const jwt = require('jsonwebtoken');
        const JWT_SECRET = getJwtSecret();
        const token = jwt.sign(
            { userId: user.id, email: user.email },
            JWT_SECRET,
            { expiresIn: '7d' }
        );


        // Track Lead (New Signup)
        const { ip, userAgent, fbp, fbc } = getClientInfo(req);
        fb.trackLead(email, ip, userAgent, fbp, fbc).catch(e => console.error(e));

        // Generate Verification Token
        const { supabaseAdmin } = require('./lib/supabase');
        const verificationToken = uuidv4();
        await supabaseAdmin.from('auth_tokens').insert({
            user_id: user.id,
            token_hash: verificationToken,
            type: 'email_verification',
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
        });

        // Send Email
        emailService.sendVerificationEmail(email, verificationToken).catch(e => console.error('Failed to send verification email:', e));


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
        let user = await db.getUserByEmail(email);

        // If no user, create one (Freemium)
        if (!user) {
            // Generate random password for Google users
            const randomPassword = auth.generatePassword();
            await auth.registerFreeUser(email, randomPassword);
            user = await db.getUserByEmail(email);

            // Track Lead
            const { ip, userAgent, fbp, fbc } = getClientInfo(req);
            fb.trackLead(email, ip, userAgent, fbp, fbc).catch(e => console.error(e));
        }

        if (!user.is_active) {
            return res.status(403).json({ error: 'Account is deactivated' });
        }

        // Generate JWT token
        const jwt = require('jsonwebtoken');
        const JWT_SECRET = getJwtSecret();
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
        if (await db.emailExists(email)) {
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
        await db.createPendingOrder(order.id, email, amountInSmallestUnit, currency);

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
        const pendingOrder = await db.getPendingOrder(razorpay_order_id);

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
        await db.deletePendingOrder(razorpay_order_id);

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
app.post('/api/auth/forgot-password', requireLoginRateLimit, async (req, res) => {
    try {
        const { email: userEmail } = req.body;

        if (!userEmail) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // Check if user exists
        const user = await db.getUserByEmail(userEmail);
        if (!user) {
            // Don't reveal if email exists or not
            return res.json({ success: true, message: 'If this email exists, a reset link has been sent.' });
        }

        // Generate reset token
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

        // Store token
        await db.createResetToken(userEmail, resetToken, expiresAt);

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
app.post('/api/auth/reset-password', requireLoginRateLimit, async (req, res) => {
    try {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return res.status(400).json({ error: 'Token and new password are required' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        // Validate token
        const resetToken = await db.getValidResetToken(token);
        if (!resetToken) {
            return res.status(400).json({ error: 'Invalid or expired reset link' });
        }

        // Update password
        const passwordHash = await auth.hashPassword(newPassword);
        await db.updatePassword(resetToken.email, passwordHash);

        // Mark token as used
        await db.markTokenUsed(token);

        res.json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// Video Generation Endpoint (Creator+ plan required)
app.post('/api/video/generate', auth.requireAuth, requireGenerateRateLimit, async (req, res) => {
    try {
        const user = req.user;
        const { imageUrl, prompt, model, endImageUrl, directorMode } = req.body;

        // Plan gating: Creator+ only for Director/Video
        const userPlan = await db.getUserPlan(user.userId);
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
            const apiKey = await resolveVeoKey(req);
            if (!apiKey) {
                return res.status(402).json(VEO_KEY_REQUIRED);
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
                await db.recordAsyncJob(operation.name, user.userId, 'veo', 'video');
                await UsageRecorder.record({
                    userId: user.userId, job: 'video_veo', model: 'veo', fundedBy: 'byok'
                });
                console.log(`🎬 Veo generation started for ${user.email}: ${operation.name}`);

                // Increment gen count
                await db.incrementGenCount(user.userId);

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
        await db.recordAsyncJob(prediction.id, user.userId, 'replicate', 'video');
        await UsageRecorder.record({
            userId: user.userId, job: 'video', fundedBy: 'platform',
            model: (model === 'wan') ? 'wan-i2v' : 'ltx-video'
        });
        console.log(`🎬 Video generation started for ${user.email}: ${prediction.id} (Model: ${model || 'wan'}, Mode: ${directorMode || 'standard'})`);

        res.json({
            success: true,
            predictionId: prediction.id,
            status: prediction.status,
            creditsRemaining: userCredits - VIDEO_COST
        });

    } catch (error) {
        return providerFailure(res, error, 'Video');
    }
});

// Google Veo Status Polling Endpoint
app.get('/api/video/veo-status/:operationName', auth.requireAuth, async (req, res) => {
    try {
        const apiKey = await resolveVeoKey(req);
        if (!apiKey) {
            return res.status(403).json({ error: 'API key required to check Veo status' });
        }

        // A provider job id is not a capability. Refuse to poll one this user
        // did not start; unknown ids read as not found rather than being
        // proxied straight through to the provider.
        const owner = await db.getAsyncJobOwner(req.params.operationName);
        if (owner !== (req.user.userId)) {
            return res.status(owner ? 403 : 404).json({ error: owner ? 'Unauthorized' : 'Not found' });
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
app.post('/api/video/generate-veo', auth.requireAuth, requireGenerateRateLimit, async (req, res) => {
    try {
        const user = req.user;
        const userPlan = await db.getUserPlan(user.userId);
        const planConfig = getPlanConfig(userPlan.plan);

        if (!planConfig.veo) {
            return res.status(403).json({ error: 'Google Veo requires Creator plan or higher.' });
        }

        const { prompt, imageBase64, imageMimeType } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        const apiKey = await resolveVeoKey(req);
        if (!apiKey) {
            return res.status(402).json(VEO_KEY_REQUIRED);
        }

        const ai = new GoogleGenAI({ apiKey });
        const generateParams = { model: 'veo-2-generate-001', prompt };

        if (imageBase64) {
            generateParams.image = { imageBytes: imageBase64, mimeType: imageMimeType || 'image/png' };
        }

        const operation = await ai.models.generateVideos(generateParams);
        await db.recordAsyncJob(operation.name, user.userId, 'veo', 'video');
        await UsageRecorder.record({
            userId: user.userId, job: 'video_veo', model: 'veo', fundedBy: 'byok'
        });
        console.log(`🎬 Veo standalone generation for ${user.email}: ${operation.name}`);

        await db.incrementGenCount(user.userId);

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
        const assets = await db.getPublicGallery(50);
        res.json({ assets });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Flux Image Generation Endpoint (Casting)
app.post('/api/image/generate-flux', auth.requireAuth, requireGenerateRateLimit, async (req, res) => {
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
        await db.recordAsyncJob(prediction.id, user.userId, 'replicate', 'image');
        await UsageRecorder.record({
            userId: user.userId, job: 'flux_image', model: 'flux-schnell', fundedBy: 'platform'
        });

        console.log(`🎨 Flux generation started for ${user.email}: ${prediction.id}`);

        res.json({
            success: true,
            predictionId: prediction.id,
            status: prediction.status,
            creditsRemaining: userCredits - FLUX_COST
        });

    } catch (error) {
        return providerFailure(res, error, 'Flux');
    }
});

// Video Status Endpoint
app.get('/api/video/status/:id', auth.requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        // A provider job id is not a capability. Refuse to poll one this user
        // did not start; unknown ids are treated as not found rather than
        // proxied straight through to the provider.
        const owner = await db.getAsyncJobOwner(id);
        if (owner !== (req.user.userId)) {
            return res.status(owner ? 403 : 404).json({ error: owner ? 'Unauthorized' : 'Not found' });
        }

        const prediction = await replicate.getPredictionStatus(id);
        res.json(prediction);
    } catch (error) {
        console.error('Video status error:', error);
        res.status(500).json({ error: 'Failed to check video status' });
    }
});

// ============ UGC NODE ENGINE ROUTES ============

// Generate UGC Script via Gemini
app.post('/api/ugc/generate-script', auth.requireAuth, requireGenerateRateLimit, async (req, res) => {
    try {
        // Plan gating: Pro+ only
        const userPlan = await db.getUserPlan(req.user.userId);
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

        const result = await db.createUGCProject(userId, name || 'Untitled Project', JSON.stringify(workflow), thumbnail);
        res.json({ success: true, id: result.lastInsertRowid });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get User Projects
app.get('/api/ugc/projects', auth.requireAuth, async (req, res) => {
    try {
        const userId = auth.getUserId(req);
        const projects = await db.getUserProjects(userId);
        res.json({ projects });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Load Project
app.get('/api/ugc/projects/:id', auth.requireAuth, async (req, res) => {
    try {
        const project = await db.getProjectById(req.params.id);
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
        const assets = await db.getUserGallery(userId);
        res.json({ assets });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============ REVISED RENDER ROUTES (Auto-Save) ============

// Render Scene with Face Consistency (InstantID) or Video (Veo)
app.post('/api/ugc/render-scene', auth.requireAuth, requireGenerateRateLimit, async (req, res) => {
    try {
        const { prompt, faceImage, productImage, faceStrength, model } = req.body;
        const user = req.user;
        const userId = user.userId;

        if (!prompt) {
            return res.status(400).json({ error: 'Scene prompt is required' });
        }

        // --- Veo Video Generation Path ---
        if (model === 'veo') {
            const userPlan = await db.getUserPlan(userId);
            const planConfig = getPlanConfig(userPlan.plan);

            if (!planConfig.veo) {
                return res.status(403).json({ error: 'Google Veo requires Pro Founder LTD or higher.' });
            }

            // Check BYOK Limits
            if (planConfig.byok_gen_limit !== Infinity && userPlan.monthly_gen_count >= planConfig.byok_gen_limit) {
                return res.status(403).json({ error: `Monthly BYOK limit reached (${planConfig.byok_gen_limit}). Please upgrade for more.` });
            }

            const apiKey = await resolveVeoKey(req);
            if (!apiKey) {
                return res.status(402).json(VEO_KEY_REQUIRED);
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
            await db.recordAsyncJob(operation.name, userId, 'veo', 'ugc_scene');
            await UsageRecorder.record({
                userId, job: 'ugc_scene_veo', model: 'veo', fundedBy: 'byok'
            });
            await db.incrementGenCount(userId); // Deduct from BYOK limit

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

        await db.recordAsyncJob(prediction.id, userId, 'replicate', 'ugc_scene');
        await UsageRecorder.record({
            userId, job: 'ugc_scene', fundedBy: 'platform',
            model: faceImage ? 'instant-id' : 'flux-schnell'
        });

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
        await db.addToGallery(userId, projectId || null, type, url, prompt);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Poll Scene/Video Render Status
app.get('/api/ugc/render-scene/status/:id', auth.requireAuth, async (req, res) => {
    try {
        const id = decodeURIComponent(req.params.id);

        // A provider job id is not a capability. Refuse to poll one this user
        // did not start; unknown ids read as not found rather than being
        // proxied straight through to the provider.
        const owner = await db.getAsyncJobOwner(id);
        if (owner !== (req.user.userId)) {
            return res.status(owner ? 403 : 404).json({ error: owner ? 'Unauthorized' : 'Not found' });
        }

        // If it's a Google Veo Operation ID
        if (id.startsWith('projects/') || id.startsWith('operations/')) {
            const apiKey = await resolveVeoKey(req);
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

// Job Registry Route
app.get('/api/jobs', auth.requireAuth, async (req, res) => {
    try {
        const jobs = JobRegistry.getJobs();
        res.json(jobs);
    } catch (error) {
        console.error('Error fetching jobs:', error);
        res.status(500).json({ error: 'Failed to fetch jobs' });
    }
});

// Redirect root to landing page if not authenticated
app.get('/', async (req, res) => {
    res.redirect('/landing.html');
});

// Run founder migration on startup (idempotent)
// db.migrateFounders().catch(console.error); // Deprecated in Supabase architecture

// ==========================================
// WEEK 2: PRODUCTION ENGINES & OUTPUTS
// ==========================================

// Get available photography packs
app.get('/api/engines/photography/packs', auth.requireAuth, async (req, res) => {
    try {
        const packs = PhotographyEngine.getPacks();
        res.json(packs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start a Photography Shoot
app.post('/api/products/:id/jobs/photography', auth.requireAuth, async (req, res) => {
    try {
        const { packId, aspectRatio } = req.body;
        const collection = await PhotographyEngine.startShoot(req.user.userId, req.params.id, packId, aspectRatio);
        // Return 202 Accepted because the job runs asynchronously
        res.status(202).json(collection);
    } catch (error) {
        console.error(error);
        if (error.status === 403) return res.status(403).json({ error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// Get available commerce packs
app.get('/api/engines/commerce/packs', auth.requireAuth, async (req, res) => {
    try {
        const packs = CommerceEngine.getPacks();
        res.json(packs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start a Commerce Production Run
app.post('/api/products/:id/jobs/commerce', auth.requireAuth, async (req, res) => {
    try {
        const { packId, productContext, inputImageId } = req.body;
        const collection = await CommerceEngine.startRun(req.user.userId, req.params.id, packId, productContext, inputImageId);
        // Return 202 Accepted because the job runs asynchronously
        res.status(202).json(collection);
    } catch (error) {
        console.error(error);
        if (error.status === 403) return res.status(403).json({ error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// Get available campaign blueprint packs
app.get('/api/engines/campaign_blueprint/packs', auth.requireAuth, async (req, res) => {
    try {
        const packs = BlueprintEngine.getPacks();
        res.json(packs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start a Campaign Blueprint Run
app.post('/api/products/:id/jobs/campaign_blueprint', auth.requireAuth, async (req, res) => {
    try {
        const { packId, productContext, inputImageId } = req.body;
        const collection = await BlueprintEngine.startRun(req.user.userId, req.params.id, packId, productContext, inputImageId);
        res.status(202).json(collection);
    } catch (error) {
        console.error(error);
        if (error.status === 403) return res.status(403).json({ error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// Start Campaign Production Run
app.post('/api/products/:id/jobs/campaign_production', auth.requireAuth, async (req, res) => {
    try {
        const { blueprintId, conceptIds, productContext } = req.body;
        const collection = await ProductionEngine.startRun(req.user.userId, req.params.id, blueprintId, conceptIds, productContext);
        res.status(202).json(collection);
    } catch (error) {
        console.error(error);
        if (error.status === 403) return res.status(403).json({ error: error.message });
        res.status(500).json({ error: error.message });
    }
});

// Poll an Output Collection (Production Job) status
app.get('/api/collections/:id', auth.requireAuth, async (req, res) => {
    try {
        const collection = await OutputService.getCollection(req.params.id);
        if (!collection) return res.status(404).json({ error: 'Not found' });

        // A collection belongs to a product, which belongs to a workspace.
        // Without this, any signed-in user could poll anyone else's job.
        const product = await ProductService.getProductById(collection.product_id);
        const workspace = await WorkspaceService.getOrCreateWorkspace(req.user.userId);
        if (!product || product.workspace_id !== workspace.id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        res.json(collection);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Set Primary Output for a Product
app.put('/api/products/:id/primary-output', auth.requireAuth, async (req, res) => {
    try {
        const { outputId } = req.body;

        // This wrote straight to products by id, so any signed-in user could
        // repoint another workspace's product at an arbitrary output.
        const product = await ProductService.getProductById(req.params.id);
        const workspace = await WorkspaceService.getOrCreateWorkspace(req.user.userId);
        if (!product || product.workspace_id !== workspace.id) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const { error } = await supabaseAdmin
            .from('products')
            .update({ primary_output_id: outputId })
            .eq('id', req.params.id);

        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Start the Server
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
}
module.exports = app;
