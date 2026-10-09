const xss = require('xss');

function sanitizeObject(obj) {
    if (typeof obj === 'string') {
        return xss(obj);
    }
    if (Array.isArray(obj)) {
        return obj.map(item => sanitizeObject(item));
    }
    if (typeof obj === 'object' && obj !== null) {
        const result = {};
        for (const key in obj) {
            // Don't sanitize keys, only values.
            result[key] = sanitizeObject(obj[key]);
        }
        return result;
    }
    return obj;
}

function xssMiddleware(req, res, next) {
    if (req.body) req.body = sanitizeObject(req.body);
    if (req.query) req.query = sanitizeObject(req.query);
    if (req.params) req.params = sanitizeObject(req.params);
    next();
}

module.exports = xssMiddleware;
