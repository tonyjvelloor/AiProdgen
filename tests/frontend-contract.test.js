const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

// The UI wrote the key as 'gemini_api_key' while six read sites used
// 'geminiApiKey', so BYOK silently never worked on those paths. Making Veo
// BYOK-only turned that latent bug into a hard failure. Same shape as
// credit_transactions.reference_type and the user_keys / user_api_keys split.
describe('API key storage uses one name', () => {
    // Only these three names are legitimate. 'gemini_api_key' survives as a
    // read for the one-time migration of keys saved before they were stored
    // server-side; the other two hold a marker and a masked hint, never a key.
    const ALLOWED = new Set(['gemini_api_key', 'gemini_key_saved', 'gemini_key_masked']);

    test('no page uses a variant spelling', () => {
        const offenders = [];
        for (const page of pages) {
            for (const m of read(page).matchAll(/localStorage\.(?:get|set|remove)Item\('([^']*)'/g)) {
                if (/gemini/i.test(m[1]) && !ALLOWED.has(m[1])) offenders.push(`${page}: ${m[1]}`);
            }
        }
        assert.deepStrictEqual(offenders, [], `variant API key names: ${offenders.join(', ')}`);
    });

    // The raw key belongs in the encrypted vault, not in storage any script on
    // the page can read.
    test('no page writes the raw key to localStorage', () => {
        const offenders = pages.filter((p) => read(p).includes("setItem('gemini_api_key'"));
        assert.deepStrictEqual(offenders, [], `pages storing the raw key: ${offenders.join(', ')}`);
    });

    test('the key is saved to the encrypted vault', () => {
        const savers = pages.filter((p) => /fetch\('\/api\/keys\/add'/.test(read(p)));
        assert.ok(savers.length > 0, 'nothing calls /api/keys/add — the vault would stay unused');
    });

    test('no page puts a key in a URL', () => {
        const offenders = pages.filter((p) => /[?&]apiKey=\$\{|urlParams\.get\('key'\)/.test(read(p)));
        assert.deepStrictEqual(offenders, [], `pages putting a key in a URL: ${offenders.join(', ')}`);
    });
});

describe('Veo BYOK is handled in the UI', () => {
    // Veo now returns 402 BYOK_REQUIRED with no user key. Surfacing that as a
    // generic error gives the user nothing to act on.
    for (const page of ['app.html', 'ugc.html']) {
        test(`${page} handles BYOK_REQUIRED`, () => {
            const src = read(page);
            assert.ok(src.includes('handleByokRequired'), `${page} has no BYOK handler`);
            assert.ok(src.includes('BYOK_REQUIRED'), `${page} does not check the error code`);
        });
    }
});

describe('admin dashboard binds only existing elements', () => {
    const src = read('admin.html');
    const ids = new Set([...src.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));

    test('every field the script sets has an element', () => {
        const used = [...new Set([...src.matchAll(/set\('([A-Za-z0-9_-]+)'/g)].map((m) => m[1]))];
        const missing = used.filter((u) => !ids.has(u));
        assert.deepStrictEqual(missing, [], `bound but absent from the page: ${missing.join(', ')}`);
    });

    test('cost coverage is displayed, not just fetched', () => {
        assert.ok(ids.has('costCoverage'),
            'coverage must be visible — otherwise AI Cost reads as complete when it is a lower bound');
    });
});

describe('marketing claims match the plan limits', () => {
    test('no page promises unlimited generation', () => {
        const offenders = pages.filter((p) => /unlimited\s+(generation|image|video|render|asset)/i.test(read(p)));
        assert.deepStrictEqual(offenders, [], `pages claiming unlimited generation: ${offenders.join(', ')}`);
    });
});
