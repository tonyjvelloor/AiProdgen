const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const { requireRateLimit, requireLoginRateLimit } = require('../lib/ratelimit');

describe('rate limit resilience & fail-closed policies', () => {
    const originalEnv = process.env.RATELIMIT_FAIL_CLOSED;

    afterEach(() => {
        if (originalEnv === undefined) delete process.env.RATELIMIT_FAIL_CLOSED;
        else process.env.RATELIMIT_FAIL_CLOSED = originalEnv;
    });

    test('fail-closed returns 503 on expensive routes when configured and error occurs', async () => {
        process.env.RATELIMIT_FAIL_CLOSED = 'true';
        const middleware = requireRateLimit('photography');

        // Mock req that causes an error or simulates failure
        const req = {
            headers: {},
            get user() {
                throw new Error('Simulated Redis failure');
            }
        };
        let statusCode = null;
        let responseBody = null;
        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (body) => { responseBody = body; }
                };
            }
        };
        let nextCalled = false;
        const next = () => { nextCalled = true; };

        await middleware(req, res, next);
        assert.strictEqual(statusCode, 503);
        assert.strictEqual(nextCalled, false);
        assert.ok(responseBody.error.includes('Rate limiting service temporarily unavailable'));
    });

    test('fallback in-memory limiter blocks excessive login attempts on limiter failure', async () => {
        const ip = '192.0.2.99';
        // Mock req that throws when accessed, triggering catch block
        let count = 0;
        const req = {
            get headers() {
                count++;
                if (count % 2 === 1) {
                    throw new Error('Simulated Redis network timeout');
                }
                return { 'x-forwarded-for': ip };
            }
        };
        let statusCode = null;
        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: () => {}
                };
            }
        };
        let blocked = false;

        for (let i = 0; i < 12; i++) {
            let nextCalled = false;
            await requireLoginRateLimit(req, res, () => { nextCalled = true; });
            if (statusCode === 429) {
                blocked = true;
                break;
            }
        }

        assert.strictEqual(blocked, true, 'Excessive login requests should be throttled by in-memory fallback on Redis error');
    });
});
