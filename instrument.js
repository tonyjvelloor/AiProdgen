// instrument.js
//
// Sentry has to initialise before anything else is required, so its
// instrumentation can patch http, express and the rest as they load. Requiring
// it from the middle of server.js -- after express, cors, the email service and
// the rate limiter had already been imported -- meant those modules were never
// instrumented.
//
// Required first from api/index.js (the Vercel entry) and from server.js.
require('dotenv').config();

const Sentry = require('@sentry/node');

const dsn = process.env.SENTRY_DSN;

// No default DSN here on purpose. A DSN is not a credential, but committing one
// means anyone who can read the repo can spend the error quota, and this repo
// may yet be made public.
if (dsn) {
    Sentry.init({
        dsn,
        environment: process.env.NODE_ENV || 'development',
        release: process.env.VERCEL_GIT_COMMIT_SHA || process.env.npm_package_version || '1.0.0',
        // Full tracing is fine at current volume and useful while the product
        // has no traffic history. Lower it once there is real load.
        tracesSampleRate: 1.0,
        // Generation prompts and API keys travel in request bodies, so they are
        // kept out of error reports.
        sendDefaultPii: false,
        beforeSend(event) {
            if (event.request) {
                delete event.request.data;
                delete event.request.cookies;
                if (event.request.headers) {
                    delete event.request.headers.authorization;
                    delete event.request.headers['x-api-key'];
                    delete event.request.headers.cookie;
                }
            }
            return event;
        }
    });
    console.log('Sentry initialised.');
} else if (process.env.NODE_ENV === 'production') {
    console.warn('[observability] SENTRY_DSN is not set — runtime errors are not being reported.');
}

module.exports = { sentryEnabled: !!dsn };
