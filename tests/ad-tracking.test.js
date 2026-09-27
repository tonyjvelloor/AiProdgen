const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

describe('Facebook Conversions API credentials are not hardcoded', () => {
    // A live access_token and pixel_id were hardcoded in services/facebook.js
    // since the project's first commit. Once the repository went public, that
    // token was readable by anyone -- and it is exactly the credential used to
    // send Purchase/Lead events, so it could be used to fire fake conversions
    // and corrupt the signal ad spend is optimized against.
    const fbService = fs.readFileSync(path.join(root, 'services', 'facebook.js'), 'utf8');

    test('access token and pixel id come from the environment', () => {
        assert.ok(fbService.includes('process.env.FB_ACCESS_TOKEN'), 'access token must read from env');
        assert.ok(fbService.includes('process.env.FB_PIXEL_ID'), 'pixel id must read from env');
    });

    test('no live-looking Meta access token is committed', () => {
        // Meta user/system access tokens are long base64-ish strings, commonly
        // starting "EAA". Catches this exact class of leak if it comes back.
        assert.ok(!/['"]EAA[A-Za-z0-9]{50,}['"]/.test(fbService),
            'a hardcoded Meta access token is present in source');
    });

    test('does not initialise the SDK with an undefined token', () => {
        // bizSdk.FacebookAdsApi.init(access_token) used to run unconditionally
        // at module load. Calling it with undefined is a bad init that fails
        // silently rather than a clear "not configured" state.
        const initCall = fbService.indexOf('FacebookAdsApi.init');
        assert.notStrictEqual(initCall, -1, 'SDK init call not found');
        const guard = fbService.slice(0, initCall);
        assert.ok(/if\s*\(\s*isConfigured\s*\)/.test(fbService.slice(0, initCall + 40)) || guard.includes('isConfigured'),
            'SDK must not initialise unless credentials are present');
    });

    test('tracking calls no-op instead of throwing when unconfigured', () => {
        delete require.cache[require.resolve('../services/facebook')];
        const originalToken = process.env.FB_ACCESS_TOKEN;
        const originalPixel = process.env.FB_PIXEL_ID;
        delete process.env.FB_ACCESS_TOKEN;
        delete process.env.FB_PIXEL_ID;

        const fb = require('../services/facebook');
        assert.strictEqual(fb.isConfigured, false);

        return fb.trackLead('test@example.com', '1.2.3.4', 'ua')
            .then(() => { /* must resolve, not throw */ })
            .finally(() => {
                if (originalToken) process.env.FB_ACCESS_TOKEN = originalToken;
                if (originalPixel) process.env.FB_PIXEL_ID = originalPixel;
                delete require.cache[require.resolve('../services/facebook')];
            });
    });

    test('/api/health reports whether ad tracking is configured', () => {
        const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
        assert.ok(server.includes('adTrackingConfigured'),
            'health check must surface this — it is easy to miss right when ad spend starts');
    });
});

describe('no other service file hardcodes a live-looking secret', () => {
    // Broader sweep so the next credential of this shape does not slip in
    // through a different file the same way this one did.
    const patterns = [
        { name: 'Meta access token', re: /['"]EAA[A-Za-z0-9]{50,}['"]/ },
        { name: 'Replicate token', re: /['"]r8_[A-Za-z0-9]{20,}['"]/ },
        { name: 'Resend key', re: /['"]re_[A-Za-z0-9_]{20,}['"]/ },
        { name: 'Razorpay live key secret literal', re: /['"]rzp_live_[A-Za-z0-9]{10,}['"]/ },
        { name: 'GitHub PAT', re: /['"]ghp_[A-Za-z0-9]{30,}['"]/ }
    ];

    const dirs = ['services', 'lib', 'api'];
    const files = [];
    for (const dir of dirs) {
        const full = path.join(root, dir);
        if (!fs.existsSync(full)) continue;
        for (const f of fs.readdirSync(full, { recursive: true })) {
            if (typeof f === 'string' && f.endsWith('.js')) files.push(path.join(full, f));
        }
    }
    files.push(path.join(root, 'server.js'));

    for (const file of files) {
        test(`${path.relative(root, file)} has no hardcoded credential`, () => {
            const src = fs.readFileSync(file, 'utf8');
            for (const { name, re } of patterns) {
                assert.ok(!re.test(src), `${file} appears to contain a hardcoded ${name}`);
            }
        });
    }
});

// Browser Pixel and server Conversions API both report Purchase and
// InitiateCheckout. Without a shared event id Meta counts every conversion
// twice, inflating ROAS and training delivery on the wrong signal.
describe('conversion events are deduplicated across Pixel and CAPI', () => {
    const fbService = fs.readFileSync(path.join(root, 'services', 'facebook.js'), 'utf8');
    const read = (f) => fs.readFileSync(path.join(root, 'public', f), 'utf8');

    test('the server sends an event id keyed on the Razorpay order', () => {
        assert.ok(fbService.includes('setEventId(eventId)'));
        assert.ok(fbService.includes('`purchase_${orderId}`'));
        assert.ok(fbService.includes('`ic_${orderId}`'));
    });

    test('the browser sends the matching eventID for each purchase', () => {
        assert.ok(read('landing.html').includes("eventID: 'purchase_' + response.razorpay_order_id"));
        assert.ok(read('landing.html').includes("eventID: 'ic_' + data.orderId"));
        assert.ok(read('app.html').includes("eventID: 'purchase_' + orderData.orderId"));
    });

    test('every server InitiateCheckout passes the order id', () => {
        const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
        const calls = [...server.matchAll(/fb\.trackInitiateCheckout\(([^)]*)\)/g)];
        assert.ok(calls.length > 0);
        for (const [, args] of calls) assert.ok(/order\.id\s*$/.test(args.trim()), `missing order id: ${args}`);
    });

    test('Lead events do not pass a plain object as custom data', () => {
        // The SDK calls customData.normalize(); a {} default threw on every Lead.
        assert.ok(!/customData\s*=\s*\{\}/.test(fbService));
        assert.ok(fbService.includes('if (customData) serverEvent.setCustomData(customData)'));
    });

    test('bulk upscale is not reported as a checkout', () => {
        assert.ok(!/fbq\('track', 'InitiateCheckout', \{\s*content_category: 'Bulk Upscale'/.test(read('app.html')));
    });

    test('the test harness never sends events to the live pixel', () => {
        const harness = fs.readFileSync(path.join(__dirname, 'helpers', 'app.js'), 'utf8');
        assert.ok(harness.includes("process.env.FB_ACCESS_TOKEN = ''"));
    });
});
