#!/usr/bin/env node
// Compares Gemini image models on a real product photo through the app's own
// production routes (not a direct API call), so it also verifies request
// shape, response parsing, retries and error handling for each model.
//
//   1. Put a billing-enabled key in .env:  GEMINI_API_KEY=...
//      (never paste it into chat or commit it)
//   2. node scripts/compare_gemini_image_models.js --photo ~/Desktop/product.jpg \
//        --description "Steel water bottle with printed logo"
//
// Runs the same six prompts app.html sends, for each model, plus the text
// model through /api/generate-text and /api/ugc/generate-script. Writes a
// side-by-side contact sheet and a JSON summary. Every row it creates in the
// database (temporary user, logs, runs) is deleted at the end.
require('dotenv').config();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MODELS = { lite: 'gemini-3.1-flash-lite-image', full: 'gemini-3.1-flash-image' };
const PRICE_PER_IMAGE = { 'gemini-3.1-flash-lite-image': 0.0336, 'gemini-3.1-flash-image': 0.067 };

function args() {
    const a = process.argv.slice(2), out = { photos: [], models: ['lite', 'full'], mode: 'product' };
    for (let i = 0; i < a.length; i++) {
        if (a[i] === '--photo') out.photos.push(path.resolve(a[++i].replace(/^~/, os.homedir())));
        else if (a[i] === '--description') out.description = a[++i];
        else if (a[i] === '--models') out.models = a[++i].split(',');
        else if (a[i] === '--mode') out.mode = a[++i];
        else if (a[i] === '--out') out.out = path.resolve(a[++i]);
        else if (a[i] === '--worker') out.worker = a[++i];
    }
    return out;
}

function promptVariations(mode) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');
    const name = mode === 'fashion' ? 'FASHION_VARIATIONS' : 'PROMPT_VARIATIONS';
    const m = html.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`));
    if (!m) throw new Error(`${name} not found in app.html`);
    return vm.runInNewContext(m[1]);
}

const mimeOf = (p) => ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(p).toLowerCase()];

async function worker(opts) {
    // Runs in a child process with GEMINI_IMAGE_MODEL already set, so
    // lib/models.js picks it up when the app is first required.
    const model = process.env.GEMINI_IMAGE_MODEL;
    const appHarness = require(path.join(ROOT, 'tests', 'helpers', 'app'));
    const db = require(path.join(ROOT, 'database'));
    const { supabaseAdmin } = require(path.join(ROOT, 'lib', 'supabase'));
    const jwt = require('jsonwebtoken');

    const user = await db.createUser(`modelcompare-${Date.now()}@example.com`, 'unused-hash', null, null, 0, 'USD');
    await db.setUserPlan(user.id, 'pro_founder_ltd', 'lifetime'); // UGC script needs a UGC plan
    const headers = {
        authorization: `Bearer ${jwt.sign({ userId: user.id, email: user.email, verified: true }, process.env.JWT_SECRET)}`,
        'content-type': 'application/json',
        'x-api-key': process.env.GEMINI_API_KEY
    };
    const result = { model, images: [], text: {}, ugcScript: {} };
    const dir = path.join(opts.out, model);
    fs.mkdirSync(dir, { recursive: true });

    try {
        await appHarness.start();
        const variations = promptVariations(opts.mode);
        let n = 0;
        for (const photo of opts.photos) {
            const input = { mimeType: mimeOf(photo), data: fs.readFileSync(photo).toString('base64') };
            for (let i = 0; i < variations.length; i++) {
                const t0 = Date.now();
                const res = await appHarness.request('POST', '/api/generate-image', headers, JSON.stringify({
                    prompt: `${opts.description} ${variations[i]}`, mode: opts.mode, images: [input]
                }));
                const ms = Date.now() - t0, body = JSON.parse(res.body || '{}');
                const row = { photo: path.basename(photo), variation: i + 1, status: res.statusCode, ms };
                if (res.statusCode === 200 && body.image) {
                    row.file = `${model}/${++n}.png`;
                    fs.writeFileSync(path.join(opts.out, row.file), Buffer.from(body.image, 'base64'));
                } else {
                    row.error = body.error || res.body.slice(0, 200);
                }
                result.images.push(row);
                console.log(`  [${model}] ${row.photo} #${i + 1}: ${res.statusCode} in ${ms}ms${row.error ? ' - ' + row.error : ''}`);
            }
        }

        let t0 = Date.now();
        let res = await appHarness.request('POST', '/api/generate-text', headers,
            JSON.stringify({ prompt: `Write a product description for: ${opts.description}`, prepromptType: 'default' }));
        let body = JSON.parse(res.body || '{}');
        result.text = { status: res.statusCode, ms: Date.now() - t0, chars: (body.text || '').length, sample: (body.text || body.error || '').slice(0, 300) };

        t0 = Date.now();
        res = await appHarness.request('POST', '/api/ugc/generate-script', headers,
            JSON.stringify({ productName: opts.description, industry: 'E-commerce', keyBenefit: 'Looks professional' }));
        body = JSON.parse(res.body || '{}');
        result.ugcScript = { status: res.statusCode, ms: Date.now() - t0, scenes: Array.isArray(body.scenes) ? body.scenes.length : 0, error: body.error };
    } finally {
        await appHarness.stop().catch(() => {});
        for (const table of ['generation_logs', 'ai_runs']) {
            await supabaseAdmin.from(table).delete().eq('user_id', user.id);
        }
        await db.deleteUser(user.id);
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
}

function contactSheet(opts, results) {
    const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const inputs = opts.photos.map(p => {
        const dest = `input-${path.basename(p)}`;
        fs.copyFileSync(p, path.join(opts.out, dest));
        return `<img src="${esc(dest)}">`;
    }).join('');
    const rows = results.map(r => {
        const ok = r.images.filter(i => i.file);
        const avg = ok.length ? Math.round(ok.reduce((s, i) => s + i.ms, 0) / ok.length) : 0;
        const cost = (PRICE_PER_IMAGE[r.model] || 0) * ok.length;
        const cells = r.images.map(i => i.file
            ? `<figure><img src="${esc(i.file)}"><figcaption>#${i.variation} · ${(i.ms / 1000).toFixed(1)}s</figcaption></figure>`
            : `<figure class="err"><div>${esc(i.error || 'failed')}</div><figcaption>#${i.variation} · HTTP ${i.status}</figcaption></figure>`).join('');
        return `<section><h2>${esc(r.model)}</h2>
<p>${ok.length}/${r.images.length} images · avg ${(avg / 1000).toFixed(1)}s · provider cost ≈ $${cost.toFixed(3)} (₹${(cost * 84).toFixed(1)})
 · copy: HTTP ${r.text.status}, ${r.text.chars} chars · UGC script: HTTP ${r.ugcScript.status}, ${r.ugcScript.scenes} scenes</p>
<div class="grid">${cells}</div></section>`;
    }).join('');
    const html = `<!doctype html><meta charset="utf-8"><title>Gemini image model comparison</title>
<style>body{font:14px system-ui;margin:24px;background:#fff;color:#111}.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}
img{width:100%;border-radius:6px;border:1px solid #ddd}figure{margin:0}figcaption{font-size:12px;color:#555}
.err div{height:120px;background:#fee;color:#900;padding:6px;font-size:12px;overflow:auto}.in img{width:220px;margin-right:8px}</style>
<h1>Product preservation: Lite vs Flash</h1><p>${esc(opts.description)} · mode: ${esc(opts.mode)}</p>
<div class="in">${inputs}</div>${rows}
<p>Judge: product identity, shape/details, text/logo, lighting, background, consistency across all six.</p>`;
    fs.writeFileSync(path.join(opts.out, 'index.html'), html);
}

(async () => {
    const opts = args();
    if (opts.worker) return worker(opts);

    if (!process.env.GEMINI_API_KEY) {
        console.error('Add a billing-enabled key to .env as GEMINI_API_KEY=... (do not paste it into chat), then re-run.');
        process.exit(1);
    }
    if (!opts.photos.length || !opts.description) {
        console.error('Usage: node scripts/compare_gemini_image_models.js --photo <product photo> [--photo ...] --description "<what the product is>" [--mode product|fashion] [--models lite,full]');
        process.exit(1);
    }
    for (const p of opts.photos) if (!fs.existsSync(p) || !mimeOf(p)) { console.error(`Not a readable jpg/png/webp: ${p}`); process.exit(1); }

    opts.out = opts.out || path.join(os.tmpdir(), `aiprodgen-model-compare-${Date.now()}`);
    fs.mkdirSync(opts.out, { recursive: true });

    const results = [];
    for (const key of opts.models) {
        const model = MODELS[key] || key;
        console.log(`\n== ${model} ==`);
        const passthrough = process.argv.slice(2).filter((a, i, all) => !['--out', '--models'].includes(a) && !['--out', '--models'].includes(all[i - 1]));
        const r = spawnSync(process.execPath, [__filename, '--worker', model, '--out', opts.out, ...passthrough], {
            env: { ...process.env, GEMINI_IMAGE_MODEL: model }, stdio: 'inherit'
        });
        const file = path.join(opts.out, model, 'result.json');
        if (r.status !== 0 || !fs.existsSync(file)) { console.error(`${model}: run failed (exit ${r.status})`); continue; }
        results.push(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    contactSheet(opts, results);
    fs.writeFileSync(path.join(opts.out, 'summary.json'), JSON.stringify(results, null, 2));
    console.log(`\nContact sheet: ${path.join(opts.out, 'index.html')}`);
})().catch(e => { console.error(e); process.exit(1); });
