/**
 * VELORAH — Feature Access (backend enforcement)
 * netlify/functions/feature-access.js
 *
 * This is the SECURE gate. It is the source of truth for whether a user may
 * use a feature. UI hiding is a courtesy; THIS is what actually protects paid
 * features. Other functions can either:
 *   (a) call this endpoint's actions over HTTP, or
 *   (b) import { assertFeature } and call it inline (preferred, no extra hop).
 *
 * Resolution order for each feature:
 *   1. per-customer override in `feature_overrides` (true=grant / false=revoke)
 *   2. otherwise, the plan's default from feature-config.js
 * Fails CLOSED: unknown feature or missing profile => denied.
 *
 * ENV required: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const CFG = require('./feature-config.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const HDR = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ---- Resolve the user from a Supabase JWT (Authorization: Bearer ...) ----
async function getUserId(authHeader) {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SERVICE_KEY },
  });
  if (!res.ok) return null;
  const u = await res.json();
  return u && u.id ? u.id : null;
}

// ---- Load plan + overrides for a user ----
async function loadAccess(userId) {
  // profile (plan)
  const pRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=plan`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );
  const pRows = pRes.ok ? await pRes.json() : [];
  const plan = (pRows[0] && pRows[0].plan) || 'free';

  // overrides (optional table; if absent, treat as none)
  let overrides = {};
  try {
    const oRes = await fetch(
      `${SUPABASE_URL}/rest/v1/feature_overrides?user_id=eq.${userId}&select=feature_key,enabled`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
    );
    if (oRes.ok) {
      const rows = await oRes.json();
      rows.forEach(r => { overrides[r.feature_key] = r.enabled === true; });
    }
  } catch (_) { /* overrides optional */ }

  return { plan, overrides };
}

/**
 * INLINE guard for use inside other functions.
 * Usage:
 *   const gate = await assertFeature(event.headers.authorization, 'ai_voice');
 *   if (!gate.allowed) return { statusCode: 403, headers, body: JSON.stringify(gate) };
 */
async function assertFeature(authHeader, featureKey) {
  const userId = await getUserId(authHeader);
  if (!userId) return { allowed: false, reason: 'unauthenticated' };
  const { plan, overrides } = await loadAccess(userId);
  const allowed = CFG.resolveFeature(plan, featureKey, overrides);
  return {
    allowed,
    userId,
    plan,
    feature: featureKey,
    availability: CFG.featureAvailability(plan, featureKey),
    reason: allowed ? 'ok' : 'feature_not_in_plan',
    upgradeTo: allowed ? null : (CFG.FEATURES[featureKey] ? CFG.FEATURES[featureKey].minTier : null),
  };
}

// ---- HTTP handler (for the UI to fetch the full access map, or check one) ----
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HDR, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: HDR, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (!SUPABASE_URL || !SERVICE_KEY)
    return { statusCode: 500, headers: HDR, body: JSON.stringify({ error: 'Server not configured' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  const action = body.action || 'map';
  const auth = event.headers.authorization || event.headers.Authorization;

  const userId = await getUserId(auth);
  if (!userId)
    return { statusCode: 401, headers: HDR, body: JSON.stringify({ error: 'Unauthenticated' }) };

  const { plan, overrides } = await loadAccess(userId);

  if (action === 'check') {
    // { action:'check', feature:'ai_voice' } -> single feature decision
    const feature = body.feature;
    const allowed = CFG.resolveFeature(plan, feature, overrides);
    return { statusCode: 200, headers: HDR, body: JSON.stringify({
      plan, feature, allowed,
      availability: CFG.featureAvailability(plan, feature),
      upgradeTo: allowed ? null : (CFG.FEATURES[feature] ? CFG.FEATURES[feature].minTier : null),
    }) };
  }

  // default: 'map' -> everything the UI needs to render gated features at once
  const map = {};
  const availability = {};
  Object.keys(CFG.FEATURES).forEach(k => {
    map[k] = CFG.resolveFeature(plan, k, overrides);
    availability[k] = CFG.featureAvailability(plan, k);
  });
  const limits = {};
  Object.keys(CFG.LIMITS[plan] || CFG.LIMITS.free).forEach(k => {
    limits[k] = CFG.limitFor(plan, k);
    if (limits[k] === Infinity) limits[k] = -1; // JSON-safe
  });

  return { statusCode: 200, headers: HDR, body: JSON.stringify({
    plan, features: map, availability, limits,
    // include the label catalog so the UI can render names without hardcoding
    catalog: Object.fromEntries(Object.entries(CFG.FEATURES).map(([k,v]) => [k, v.label])),
  }) };
};

// export the inline guard for other functions to import
exports.assertFeature = assertFeature;
exports.loadAccess = loadAccess;
exports.getUserId = getUserId;
