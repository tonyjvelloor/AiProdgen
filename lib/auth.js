// lib/auth.js
// Native Vercel functions don't share Express middleware, so every route
// that needs auth calls this directly at the top of its handler.
const jwt = require('jsonwebtoken');

function getUserFromRequest(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return null;

  try {
    const payload = jwt.verify(match[1], process.env.SESSION_JWT_SECRET || process.env.JWT_SECRET);
    return { id: payload.sub || payload.userId, email: payload.email };
  } catch (err) {
    return null; // expired or tampered token
  }
}

// Standard guard to drop at the top of any protected route handler
function requireAuth(req, res) {
  const user = getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  return user;
}

module.exports = { getUserFromRequest, requireAuth };
