// tests/helpers/app.js
//
// Drives the app the way Vercel actually invokes it: the exported handler is
// called with (req, res) from a real node:http server.
//
// The first version of these tests went through serverless-http, which builds an
// AWS Lambda (event, context) handler. That is not how the function is invoked
// in production, and it is precisely why the suite stayed green while every
// /api route on Vercel hung until FUNCTION_INVOCATION_TIMEOUT. Test the real
// entry point.
const http = require('node:http');

let server;
let origin;

async function start() {
    if (origin) return origin;
    const handler = require('../../api/index.js');
    server = http.createServer((req, res) => handler(req, res));
    await new Promise((resolve) => server.listen(0, resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    return origin;
}

async function stop() {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = undefined;
    origin = undefined;
}

// Returns { statusCode, body } so existing assertions read the same.
async function request(method, path, headers = {}, body = null) {
    const base = await start();
    const res = await fetch(base + path, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000)
    });
    return { statusCode: res.status, body: await res.text() };
}

module.exports = { start, stop, request };
