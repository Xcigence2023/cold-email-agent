/**
 * check-plan.js - Optimized with auth caching
 * - Token verification cached for 5 minutes
 * - Rate limited: 120/minute per user
 */

const authCache = new Map();
const rateStore = new Map();

async function getUser(token, supabaseUrl, serviceKey) {
  const key = token.substring(0, 40);
  const cached = authCache.get(key);
  if (cached && Date.now() < cached.exp) return cached.user;
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': serviceKey }
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;
  authCache.set(key, { user, exp: Date.now() + 300000 });
  return user;
}

function rateOk(id) {
  const now = Date.now();
  const r = rateStore.get(id) || { n: 0, t: now + 60000 };
  if (now > r.t) { r.n = 0; r.t = now + 60000; }
  r.n++; rateStore.set(id, r);
  return r.n <= 120;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };

  const token = (event.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  if (!rateOk(token.substring(0, 16))) return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests' }) };

  const user = await getUser(token, SUPABASE_URL, SERVICE_KEY);
  if (!user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=plan,leads_used_this_month,leads_limit`, {
      headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY }
    });
    const rows = await res.json();
    const p = rows?.[0] || { plan: 'free', leads_used_this_month: 0, leads_limit: 50 };
    const plan = p.plan || 'free';
    const used = p.leads_used_this_month || 0;
    const limit = p.leads_limit || 50;
    const canGenerate = limit === -1 || used < limit;
    return { statusCode: 200, headers, body: JSON.stringify({ plan, used, limit, canGenerate, remaining: limit === -1 ? 'unlimited' : Math.max(0, limit - used) }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database error' }) };
  }
};
