// api/index.js — catches all Express routes on Vercel
//
// Do not wrap this in serverless-http. That builds an AWS Lambda handler which
// expects (event, context) and returns a response object. Vercel's Node runtime
// invokes functions with (req, res) — Node/Express-shaped objects — so the shim
// reads event.httpMethod off a request, finds nothing, and never writes a
// response. Every /api route then hangs until FUNCTION_INVOCATION_TIMEOUT.
//
// An Express app is already a (req, res) handler, so it can be exported as-is.
try {
    // Before ../server, so Sentry patches modules as they load.
    require('../instrument');
    const app = require('../server');
    module.exports = app;
} catch (e) {
    module.exports = (req, res) => res.status(500).json({
        error: 'Initialization failed',
        message: e.message,
        stack: e.stack
    });
}
