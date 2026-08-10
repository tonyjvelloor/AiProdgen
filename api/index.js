// api/index.js — catches all Express routes on Vercel
try {
    const serverless = require('serverless-http');
    const app = require('../server'); // your existing Express app
    module.exports = serverless(app);
} catch (e) {
    module.exports = (req, res) => res.status(500).json({ error: "Initialization failed", message: e.message, stack: e.stack });
}
