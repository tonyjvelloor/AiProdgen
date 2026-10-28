// Default tests must never load the developer's production .env. Integration
// runs require separately supplied staging credentials and explicit opt-in.
const dotenv = require('dotenv');
dotenv.config = () => ({ parsed: {} });
const integration = process.env.RUN_INTEGRATION_TESTS === 'true';
const names = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET', 'SESSION_JWT_SECRET',
    'GEMINI_API_KEY', 'REPLICATE_API_TOKEN', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',
    'RAZORPAY_WEBHOOK_SECRET', 'RESEND_API_KEY', 'SMTP_USER', 'SMTP_PASS', 'SENTRY_DSN',
    'FB_ACCESS_TOKEN', 'FB_PIXEL_ID', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const staging = {};
for (const name of names) {
    if (integration && process.env[`TEST_${name}`]) staging[name] = process.env[`TEST_${name}`];
    delete process.env[name];
}
if (integration) {
    for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET']) {
        if (!staging[name]) throw new Error(`Integration tests require TEST_${name} for a disposable staging project.`);
    }
    Object.assign(process.env, staging);
}
process.env.FB_ACCESS_TOKEN = '';
process.env.FB_PIXEL_ID = '';
process.env.NODE_ENV = 'test';
