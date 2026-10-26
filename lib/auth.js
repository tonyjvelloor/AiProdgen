// lib/auth.js
// Native Vercel functions don't share Express middleware, so every route
// that needs auth calls this directly at the top of its handler.
const jwt = require('jsonwebtoken');

function getUserFromRequest(req) {
  // Support Bearer header, session cookie, and token cookie
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  
  const cookieHeader = req.headers?.cookie || '';
  const match = cookieHeader.match(/session=([^;]+)/) || cookieHeader.match(/token=([^;]+)/);
  const token = bearerToken || (match ? match[1] : null);

  if (!token) return null;

  try {
    const payload = jwt.verify(token, process.env.SESSION_JWT_SECRET || process.env.JWT_SECRET);
    return { 
      id: payload.sub || payload.userId, 
      userId: payload.userId || payload.sub,
      email: payload.email,
      verified: payload.verified 
    };
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
