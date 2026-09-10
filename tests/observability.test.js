const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const entry = fs.readFileSync(path.join(root, 'api', 'index.js'), 'utf8');

describe('Sentry is wired so it can actually see errors', () => {
    // setupExpressErrorHandler is an ERROR handler. It was registered right
    // after the app was created, ahead of all 69 routes, so no route error ever
    // reached it -- Sentry was installed and configured and reported nothing.
    test('the error handler is registered after every route', () => {
        const handler = server.indexOf('Sentry.setupExpressErrorHandler');
        assert.notStrictEqual(handler, -1, 'no Sentry error handler registered');

        const routes = [...server.matchAll(/^app\.(get|post|put|delete)\(/gm)].map((m) => m.index);
        assert.ok(routes.length > 0, 'no routes found');
        const lastRoute = Math.max(...routes);

        assert.ok(handler > lastRoute,
            'Sentry error handler is registered before a route — it will never see that route\'s errors');
    });

    // Sentry patches modules as they load, so it must run before they are
    // required. It previously initialised after express, cors, the email
    // service and the rate limiter had already been imported.
    test('instrument.js is required before anything else', () => {
        const instrument = server.indexOf("require('./instrument')");
        assert.notStrictEqual(instrument, -1, 'server.js does not load instrument.js');
        const firstOtherRequire = server.indexOf("require('express')");
        assert.ok(instrument < firstOtherRequire, 'Sentry must initialise before express is required');
    });

    test('the Vercel entry point instruments before loading the app', () => {
        const instrument = entry.indexOf("require('../instrument')");
        const app = entry.indexOf("require('../server')");
        assert.notStrictEqual(instrument, -1, 'api/index.js does not load instrument.js');
        assert.ok(instrument < app, 'instrument must load before the Express app');
    });
});

describe('error reports do not carry secrets', () => {
    const instrument = fs.readFileSync(path.join(root, 'instrument.js'), 'utf8');

    test('request bodies and auth headers are stripped', () => {
        assert.ok(instrument.includes('beforeSend'), 'no scrubbing hook');
        for (const field of ['authorization', 'x-api-key', 'cookie']) {
            assert.ok(instrument.includes(field), `beforeSend does not strip ${field}`);
        }
        assert.ok(/delete event\.request\.data/.test(instrument),
            'request bodies carry generation prompts and BYOK keys — they must be stripped');
    });

    test('no DSN is hardcoded', () => {
        assert.ok(!/ingest\.[a-z.]*sentry\.io/.test(instrument),
            'a committed DSN lets anyone who reads the repo spend the error quota');
    });
});
