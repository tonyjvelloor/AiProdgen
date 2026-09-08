const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const appHarness = require('./helpers/app');

require('dotenv').config();

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const HAS_CONFIG = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.JWT_SECRET);

after(async () => { await appHarness.stop(); });

// Veo is far more expensive per clip than anything else generated here, and no
// Veo route charged credits. Falling back to the platform Gemini key therefore
// let a one-time plan purchase buy unlimited Veo video on the platform's spend.
describe('Veo is BYOK only', () => {
    test('no Veo generation site can reach the platform key', () => {
        let idx = server.indexOf("'veo-2-generate-001'");
        let sites = 0;
        while (idx !== -1) {
            const preceding = server.slice(Math.max(0, idx - 1200), idx);
            const keyLine = preceding.lastIndexOf('const apiKey');
            assert.notStrictEqual(keyLine, -1, 'Veo call site has no visible key resolution');
            const resolution = preceding.slice(keyLine, keyLine + 200);
            assert.ok(
                resolution.includes('resolveVeoKey'),
                `a Veo call site resolves its key without resolveVeoKey: ${resolution.split('\n')[0]}`
            );
            sites++;
            idx = server.indexOf("'veo-2-generate-001'", idx + 1);
        }
        assert.ok(sites >= 3, `expected at least 3 Veo call sites, found ${sites}`);
    });

    test('resolveVeoKey never falls back to the environment', () => {
        const fn = server.slice(server.indexOf('function resolveVeoKey'), server.indexOf('const VEO_KEY_REQUIRED'));
        assert.ok(!fn.includes('process.env'), 'resolveVeoKey must not read a platform key');
    });
});

// Infinity meant the `monthly_gen_count >= byok_gen_limit` guards never fired.
describe('no plan grants unlimited generation', () => {
    const plansBlock = server.slice(server.indexOf('const PLANS = {'), server.indexOf('};', server.indexOf('const PLANS = {')));

    test('PLANS contains no Infinity limits', () => {
        const code = plansBlock.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
        assert.ok(!code.includes('Infinity'), 'a plan still grants an unlimited limit');
    });

    test('every paid plan requires the user to bring a key', () => {
        for (const line of plansBlock.split('\n')) {
            if (!line.includes('requires_byok')) continue;
            if (line.trim().startsWith('//')) continue;
            if (line.includes('free_explorer')) continue;
            assert.ok(line.includes('requires_byok: true'),
                `a paid plan does not require BYOK: ${line.trim().slice(0, 60)}`);
        }
    });
});

describe('platform spend ceiling', () => {
    test('PolicyEngine enforces a ceiling rather than stubbing it', () => {
        const policy = fs.readFileSync(path.join(__dirname, '..', 'lib', 'policy_engine.js'), 'utf8');
        assert.ok(policy.includes('getUserPlatformSpend'), 'ceiling must read actual spend');
        assert.ok(policy.includes('PLATFORM_SPEND_CEILING_USD'), 'ceiling must be configurable');
        // Scoped to the spend-limit stub specifically; an unrelated
        // "Workspace Active (Mock check for now)" stub also exists at the top
        // of evaluateRequest and is out of scope here.
        assert.ok(!policy.includes('Daily Spend Limits (Mock check for now)'),
            'the spend-limit stub is still present');
        assert.ok(!policy.includes('// if (dailySpend'), 'the commented-out ceiling is still present');
    });
});

describe('Veo routes reject a missing key', { skip: HAS_CONFIG ? false : 'requires env config' }, () => {
    const session = () => ({
        authorization: `Bearer ${jwt.sign({ userId: '11111111-1111-1111-1111-111111111111', email: 'x@example.com' }, process.env.JWT_SECRET)}`,
        'content-type': 'application/json'
    });

    test('/api/video/generate-veo does not 200 without a user key', async () => {
        const res = await appHarness.request('POST', '/api/video/generate-veo', session(),
            JSON.stringify({ prompt: 'a product on a table' }));
        assert.notStrictEqual(res.statusCode, 200, 'Veo must never run without a caller-supplied key');
        assert.ok([402, 403].includes(res.statusCode), `expected 402/403, got ${res.statusCode}`);
    });
});
