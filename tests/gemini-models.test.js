// tests/gemini-models.test.js
//
// gemini-2.0-flash shut down on 2026-06-01 (the marketing-copy generator and
// UGC script writer were calling it), gemini-2.5-flash-image shuts down on
// 2026-10-02, and the 2.5 family is limited to existing users for new
// projects -- which broke key validation for a new customer's own key.
// https://ai.google.dev/gemini-api/docs/deprecations
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const server = read('server.js');

const LIVE_CODE = ['server.js', 'lib', 'api', 'services'];

function jsFiles(rel) {
    const abs = path.join(root, rel);
    if (fs.statSync(abs).isFile()) return [rel];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap(d =>
        d.isDirectory() ? jsFiles(path.join(rel, d.name)) : d.name.endsWith('.js') ? [path.join(rel, d.name)] : []);
}

describe('no retired or restricted Gemini model is called', () => {
    test('no gemini-2.0 / gemini-2.5 model id outside comments', () => {
        for (const file of LIVE_CODE.flatMap(jsFiles)) {
            const code = read(file).split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
            assert.ok(!/gemini-2\.(0|5)[a-z0-9.\-]*/.test(code), `${file} still names a 2.0/2.5 Gemini model`);
        }
    });

    test('every generateContent URL in server.js uses the shared model constants', () => {
        const urls = [...server.matchAll(/v1beta\/models\/([^:`'"]+):generateContent/g)].map(m => m[1]);
        assert.ok(urls.length >= 4, 'expected the text, image, upscale and UGC-script calls');
        for (const model of urls) {
            assert.ok(['${GEMINI_TEXT_MODEL}', '${GEMINI_IMAGE_MODEL}'].includes(model), `hardcoded model: ${model}`);
        }
    });

    test('defaults are current, non-deprecated models', () => {
        delete process.env.GEMINI_IMAGE_MODEL;
        delete process.env.GEMINI_TEXT_MODEL;
        delete require.cache[require.resolve('../lib/models')];
        const { GEMINI_IMAGE_MODEL, GEMINI_TEXT_MODEL } = require('../lib/models');
        assert.strictEqual(GEMINI_IMAGE_MODEL, 'gemini-3.1-flash-lite-image');
        assert.strictEqual(GEMINI_TEXT_MODEL, 'gemini-3.8-flash');
    });

    test('platform cost for an image follows the configured model', () => {
        const { PROVIDER_PRICES } = require('../lib/cost_estimator');
        assert.strictEqual(PROVIDER_PRICES['gemini-image'], 0.0336);
    });
});

describe('Gemini 3 responses: thought parts are never the output', () => {
    // Gemini 3 image models always think; interim "thought" parts, including
    // draft images, can precede the final image.
    const src = ['geminiFinalImagePart', 'geminiAnswerText'].map(name => {
        const start = server.indexOf(`function ${name}(`);
        assert.notStrictEqual(start, -1, `${name} not found`);
        return server.slice(start, server.indexOf('\n}\n', start) + 2);
    }).join('\n');
    const ctx = {};
    vm.runInNewContext(`${src}\nthis.img = geminiFinalImagePart; this.txt = geminiAnswerText;`, ctx);

    const response = (parts) => ({ candidates: [{ content: { parts } }] });

    test('the final image is chosen over a draft thought image', () => {
        const res = response([
            { text: 'planning the shot', thought: true },
            { inlineData: { mimeType: 'image/png', data: 'DRAFT' }, thought: true },
            { text: 'Here is your image' },
            { inlineData: { mimeType: 'image/png', data: 'FINAL' }, thoughtSignature: 'sig' }
        ]);
        assert.strictEqual(ctx.img(res).inlineData.data, 'FINAL');
    });

    test('a response with only thought images yields no image rather than a draft', () => {
        assert.strictEqual(ctx.img(response([{ inlineData: { data: 'DRAFT' }, thought: true }])), null);
    });

    test('a 2.5-style response (single image part) still works', () => {
        assert.strictEqual(ctx.img(response([{ inlineData: { data: 'ONLY' } }])).inlineData.data, 'ONLY');
    });

    test('answer text excludes thought summaries', () => {
        assert.strictEqual(ctx.txt(response([{ text: 'reasoning...', thought: true }, { text: 'Headline: ' }, { text: 'Buy now' }])), 'Headline: Buy now');
        assert.strictEqual(ctx.txt(response([])), null);
    });
});
