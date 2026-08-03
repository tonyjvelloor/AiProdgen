// api/index.js — catches all Express routes on Vercel
const serverless = require('serverless-http');
const app = require('../server'); // your existing Express app

module.exports = serverless(app);
