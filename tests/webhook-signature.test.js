const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const SECRET = 'whsec_test_value';

function loadHandler(secret) {
    delete require.cache[require.resolve('../api/webhooks/razorpay')];
    if (secret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
    else process.env.RAZORPAY_WEBHOOK_SECRET = secret;
    return require('../api/webhooks/razorpay');
}

// The handler reads the raw body by async-iterating req.
function mockReq(body, signature) {
    const req = Readable.from([Buffer.from(body)]);
    req.method = 'POST';
    req.headers = signature === undefined ? {} : { 'x-razorpay-signature': signature };
    return req;
}

function mockRes() {
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.send = (b) => { res.body = b; return res; };
    res.end = () => res;
    return res;
}

const payload = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', notes: {} } } } });
const sign = (body, secret) => crypto.createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');

describe('razorpay webhook signature', () => {
    beforeEach(() => { process.env.SUPABASE_URL = process.env.SUPABASE_URL || ''; });

    // Regression: the secret used to fall back to the literal 'test_secret',
    // so anyone who read this repo could forge a paid entitlement.
    test('rejects when the webhook secret is not configured', async () => {
        const handler = loadHandler(undefined);
        const res = mockRes();
        await handler(mockReq(payload, sign(payload, 'test_secret')), res);
        assert.strictEqual(res.statusCode, 503);
    });

    test('rejects a signature computed with the old default secret', async () => {
        const handler = loadHandler(SECRET);
        const res = mockRes();
        await handler(mockReq(payload, sign(payload, 'test_secret')), res);
        assert.strictEqual(res.statusCode, 400);
    });

    test('rejects a missing signature header', async () => {
        const handler = loadHandler(SECRET);
        const res = mockRes();
        await handler(mockReq(payload, undefined), res);
        assert.strictEqual(res.statusCode, 400);
    });

    test('rejects a tampered body', async () => {
        const handler = loadHandler(SECRET);
        const res = mockRes();
        const good = sign(payload, SECRET);
        await handler(mockReq(payload.replace('pay_1', 'pay_2'), good), res);
        assert.strictEqual(res.statusCode, 400);
    });

    test('accepts a correctly signed request', async () => {
        const handler = loadHandler(SECRET);
        const res = mockRes();

        // With no database configured the handler gets past verification and
        // then fails reaching Supabase. Either outcome proves the signature was
        // accepted; a rejected signature would have returned 400 before that.
        let reachedDatabase = false;
        try {
            await handler(mockReq(payload, sign(payload, SECRET)), res);
        } catch (err) {
            reachedDatabase = /Supabase is not configured/.test(err.message);
            if (!reachedDatabase) throw err;
        }

        assert.ok(
            reachedDatabase || res.statusCode !== 400,
            'a valid signature must pass verification'
        );
    });

    test('rejects a non-POST request', async () => {
        const handler = loadHandler(SECRET);
        const res = mockRes();
        const req = mockReq(payload, sign(payload, SECRET));
        req.method = 'GET';
        await handler(req, res);
        assert.strictEqual(res.statusCode, 405);
    });
});

describe('placeholder webhook secrets', () => {
    // RAZORPAY_WEBHOOK_SECRET=test_secret appeared in a real .env. It was this
    // file's old hardcoded fallback and is in the git history, so accepting it
    // would restore the forged-entitlement bypass.
    for (const placeholder of ['test_secret', 'TEST_SECRET', ' test_secret ', 'changeme']) {
        test(`refuses to trust ${JSON.stringify(placeholder)}`, async () => {
            const handler = loadHandler(placeholder);
            const res = mockRes();
            await handler(mockReq(payload, sign(payload, placeholder)), res);
            assert.strictEqual(res.statusCode, 503,
                'a placeholder secret must be treated as unconfigured');
        });
    }
});
