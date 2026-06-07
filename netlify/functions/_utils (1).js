/**
 * Shared utility module for all Netlify functions
 * Handles: auth verification, rate limiting, input sanitization, CORS
 */

// ── RATE LIMITING ─────────────────────────────────────────
// In-memory store (resets on function cold start — acceptable for edge rate limiting)
const rateLimitStore = new Map();

function checkRateLimit(identifier, maxRequests = 60, windowMs = 60000) {
  const now = Date.now();
  const key = identifier;
  const record = rateLimitStore.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }

  record.count++;
  rateLimitStore.set(key, record);

  // Clean up old entries every 100 calls
  if (rateLimitStore.size > 500) {
    for (const [k, v] of rateLimitStore.entries()) {
      if (now > v.resetAt) rateLimitStore.delete(k);
    }
  }

  return {
    allowed: record.count <= maxRequests,
    remaining: Math.max(0, maxRequests - record.count),
    resetAt: record.resetAt
  };
}

// ── AUTH VERIFICATION ─────────────────────────────────────
// Simple in-memory cache for verified tokens (5 min TTL)
const authCache = new Map();

async function verifyUser(token, supabaseUrl, serviceKey) {
  if (!token) return null;

  const cacheKey = token.substring(0, 32);
  const cached = authCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.user;

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': serviceKey }
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user.id) return null;

    // Cache for 5 minutes
    authCache.set(cacheKey, { user, expiresAt: Date.now() + 300000 });

    // Cleanup old cache entries
    if (authCache.size > 200) {
      const now = Date.now();
      for (const [k, v] of authCache.entries()) {
        if (now > v.expiresAt) authCache.delete(k);
      }
    }

    return user;
  } catch(e) {
    return null;
  }
}

// ── INPUT SANITIZATION ────────────────────────────────────
function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().substring(0, maxLen).replace(/[<>]/g, '');
}

function sanitizeEmail(email) {
  if (typeof email !== 'string') return '';
  const clean = email.trim().toLowerCase().substring(0, 255);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? clean : '';
}

function sanitizeInt(val, min = 1, max = 100, def = 25) {
  const n = parseInt(val);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// ── CORS HEADERS ──────────────────────────────────────────
function getCorsHeaders(allowedOrigin = '*') {
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff'
  };
}

// ── RESPONSE HELPERS ──────────────────────────────────────
function ok(data, headers = {}) {
  return { statusCode: 200, headers: { ...getCorsHeaders(), ...headers }, body: JSON.stringify(data) };
}

function err(message, statusCode = 400, headers = {}) {
  return { statusCode, headers: { ...getCorsHeaders(), ...headers }, body: JSON.stringify({ error: message }) };
}

function unauthorized(headers = {}) {
  return err('Unauthorized', 401, headers);
}

function rateLimited(headers = {}) {
  return err('Too many requests. Please slow down.', 429, headers);
}

module.exports = { checkRateLimit, verifyUser, sanitizeString, sanitizeEmail, sanitizeInt, getCorsHeaders, ok, err, unauthorized, rateLimited };
