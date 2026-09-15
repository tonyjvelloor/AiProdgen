// tests/referral-capture.test.js
//
// Release D6: the thinnest possible acquisition loop --
//   ?ref=CODE -> first-party capture -> signup -> referral attached ->
//   eligible purchase -> commission (already proven in tests/referrals.test.js)
// This file proves the missing link: that a real signup, through the real
// HTTP routes, with a referralCode in the body, actually creates the
// referrals row. No cookies/localStorage here (that's public/js/referral.js,
// a browser-only concern) -- this starts from "the client already carried
// the code to the signup call," which is the part the backend is
// responsible for.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

require('dotenv').config();

const HAS_CONFIG = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.JWT_SECRET);
const skip = HAS_CONFIG ? false : 'requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and JWT_SECRET';

const appHarness = require('./helpers/app');
const db = require('../database');
const referrals = require('../lib/referrals');
const { supabaseAdmin } = require('../lib/supabase');

after(async () => { await appHarness.stop(); });

const createdUserIds = [];
after(async () => {
    for (const id of createdUserIds) await db.deleteUser(id).catch(() => {});
});

async function makeUser(label) {
    const user = await db.createUser(`capture-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`, 'unused-hash', null, null, 0, 'USD');
    createdUserIds.push(user.id);
    return user;
}

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

describe('the frontend capture script exists and is included where a referral link could land', () => {
    test('public/js/referral.js exists and is first-click-wins', () => {
        const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'referral.js'), 'utf8');
        assert.ok(script.includes("get('ref')"), 'must read ?ref= from the URL');
        assert.ok(script.includes('!localStorage.getItem'), 'must not overwrite an already-captured code');
    });

    for (const page of ['landing.html', 'index.html', 'login.html']) {
        test(`${page} includes the capture script`, () => {
            const html = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
            assert.ok(html.includes('/js/referral.js'), `${page} must load the capture script`);
        });
    }
});

describe('signup routes accept and use referralCode', () => {
    for (const route of ["app.post('/api/auth/signup'", "app.post('/api/auth/google'", "app.post('/api/payment/verify'"]) {
        test(`${route} attributes a referral for a new account`, () => {
            const start = server.indexOf(route);
            const end = server.indexOf("app.post(", start + 10);
            const body = server.slice(start, end === -1 ? start + 3000 : end);
            assert.ok(body.includes('referralCode'), `${route} must read referralCode from the request`);
            assert.ok(body.includes('referrals.attributeReferral'), `${route} must attribute it on a new account`);
        });
    }

    test('/api/plan/verify (an upgrade, not a signup) does NOT attribute -- only records against an existing referral', () => {
        const start = server.indexOf("app.post('/api/plan/verify'");
        const end = server.indexOf("app.post(", start + 10);
        const body = server.slice(start, end === -1 ? start + 3000 : end);
        assert.ok(!body.includes('referrals.attributeReferral'), 'an existing-user upgrade must never create a new attribution');
        assert.ok(body.includes('referrals.recordEligiblePayment'), 'it must still check for one that already exists');
    });
});

describe('Partner Program routes', { skip }, () => {
    test('GET /api/referral/code requires auth', async () => {
        const res = await appHarness.request('GET', '/api/referral/code');
        assert.strictEqual(res.statusCode, 401);
    });

    test('GET /api/referral/code returns a stable code and a shareable URL', async () => {
        const partner = await makeUser('routecode');
        const headers = { authorization: `Bearer ${jwt.sign({ userId: partner.id, email: partner.email }, process.env.JWT_SECRET)}` };

        const first = await appHarness.request('GET', '/api/referral/code', headers);
        const second = await appHarness.request('GET', '/api/referral/code', headers);
        const firstBody = JSON.parse(first.body), secondBody = JSON.parse(second.body);

        assert.strictEqual(first.statusCode, 200);
        assert.ok(firstBody.code);
        assert.strictEqual(firstBody.code, secondBody.code, 'the code must be stable across calls');
        assert.ok(firstBody.url.endsWith(`?ref=${firstBody.code}`));
    });

    test('GET /api/referral/summary requires auth and returns a zero state for a partner with no referrals', async () => {
        const anon = await appHarness.request('GET', '/api/referral/summary');
        assert.strictEqual(anon.statusCode, 401);

        const partner = await makeUser('routesummary');
        const headers = { authorization: `Bearer ${jwt.sign({ userId: partner.id, email: partner.email }, process.env.JWT_SECRET)}` };
        const res = await appHarness.request('GET', '/api/referral/summary', headers);
        const body = JSON.parse(res.body);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(body.pendingCents, 0);
        assert.strictEqual(body.availableCents, 0);
        assert.strictEqual(body.payoutEligible, false);
    });
});

describe('the full loop through the real HTTP signup route', { skip }, () => {
    // This is the one test that goes all the way from a partner's code,
    // through the actual /api/auth/signup route (not calling
    // attributeReferral directly), to a referral row existing for the new
    // account -- proving the wiring, not just the module.
    test('a free signup with referralCode in the body creates a pending referral', async () => {
        const partner = await makeUser('e2e-partner');
        const code = await referrals.getOrCreateReferralCode(partner.id);
        const email = `capture-e2e-signup-${Date.now()}@example.com`;

        const res = await appHarness.request('POST', '/api/auth/signup',
            { 'content-type': 'application/json' },
            JSON.stringify({ email, password: 'a-fine-password-123', referralCode: code }));

        assert.strictEqual(res.statusCode, 200, res.body);
        const newUser = await db.getUserByEmail(email);
        assert.ok(newUser);
        createdUserIds.push(newUser.id);

        const { data: referral } = await supabaseAdmin.from('referrals').select('*').eq('referred_user_id', newUser.id).maybeSingle();
        assert.ok(referral, 'signing up with a referralCode must create a referrals row');
        assert.strictEqual(referral.referrer_user_id, partner.id);
        assert.strictEqual(referral.status, 'pending');
    });

    // The architectural rule stated explicitly: capture happens before
    // signup, but the relationship is established only on a SUCCESSFUL one.
    // A signup call with a garbage code must not fail the signup, and must
    // not create a referral out of nothing.
    test('an invalid referralCode does not break signup and creates no referral', async () => {
        const email = `capture-e2e-badcode-${Date.now()}@example.com`;
        const res = await appHarness.request('POST', '/api/auth/signup',
            { 'content-type': 'application/json' },
            JSON.stringify({ email, password: 'a-fine-password-123', referralCode: 'NOT_A_REAL_CODE' }));

        assert.strictEqual(res.statusCode, 200, res.body);
        const newUser = await db.getUserByEmail(email);
        createdUserIds.push(newUser.id);

        const { data: referral } = await supabaseAdmin.from('referrals').select('id').eq('referred_user_id', newUser.id).maybeSingle();
        assert.strictEqual(referral, null);
    });

    test('signing up with no referralCode at all works exactly as before', async () => {
        const email = `capture-e2e-none-${Date.now()}@example.com`;
        const res = await appHarness.request('POST', '/api/auth/signup',
            { 'content-type': 'application/json' },
            JSON.stringify({ email, password: 'a-fine-password-123' }));
        assert.strictEqual(res.statusCode, 200, res.body);
        const newUser = await db.getUserByEmail(email);
        createdUserIds.push(newUser.id);
    });
});
