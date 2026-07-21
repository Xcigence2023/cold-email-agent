/**
 * VELORAH — Automatic feature assignment
 * netlify/functions/assign-features.js  (also exported for inline use)
 *
 * KEY IDEA: features are DERIVED from the plan, so "assignment" is automatic —
 * the moment a customer's `profiles.plan` changes, their feature set changes
 * with it (feature-config.js maps plan -> features). There is no manual step.
 *
 * This module does two jobs:
 *   1. assignForPlan(userId, newPlan) — writes an audit-log row snapshotting the
 *      features the customer now has. Call this from the Stripe webhook whenever
 *      a plan is activated/changed/cancelled, and on signup.
 *   2. An HTTP handler an admin can call to manually re-assign or grant overrides.
 *
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY
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

function sb(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

/**
 * Record that a customer has been (re)assigned the feature set for `newPlan`.
 * Idempotent-friendly: safe to call repeatedly; it just logs snapshots.
 * Returns the resolved feature list.
 */
async function assignForPlan(userId, newPlan, source = 'stripe_webhook', oldPlan = null) {
  if (!userId || !newPlan) return { ok: false, error: 'missing userId or plan' };

  // Pull any overrides so the snapshot reflects true access.
  let overrides = {};
  try {
    const oRes = await sb(`feature_overrides?user_id=eq.${userId}&select=feature_key,enabled`);
    if (oRes.ok) (await oRes.json()).forEach(r => { overrides[r.feature_key] = r.enabled === true; });
  } catch (_) {}

  const features = CFG.featuresForPlan(newPlan, overrides);

  // Best-effort audit log (don't fail the whole flow if logging fails).
  try {
    await sb('feature_assignments_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: userId,
        old_plan: oldPlan,
        new_plan: newPlan,
        features: features,
        source,
      }),
    });
  } catch (_) {}

  return { ok: true, plan: newPlan, features };
}

/**
 * Admin: set or clear a per-customer override.
 * enabled=true grants, enabled=false revokes, enabled=null removes the override
 * (reverting to plan default).
 */
async function setOverride(userId, featureKey, enabled, reason = null, by = 'admin') {
  if (!CFG.FEATURES[featureKey]) return { ok: false, error: 'unknown feature' };

  if (enabled === null) {
    await sb(`feature_overrides?user_id=eq.${userId}&feature_key=eq.${featureKey}`, { method: 'DELETE' });
    return { ok: true, removed: true };
  }

  // Upsert
  const res = await sb('feature_overrides', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ user_id: userId, feature_key: featureKey, enabled, reason, created_by: by }),
  });
  const row = res.ok ? await res.json() : null;
  return { ok: res.ok, override: row };
}

// ---- HTTP handler (admin actions). Protect this with an admin check in prod. ----
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HDR, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: HDR, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!SUPABASE_URL || !SERVICE_KEY)
    return { statusCode: 500, headers: HDR, body: JSON.stringify({ error: 'Server not configured' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}

  // NOTE: In production, verify the caller is an admin here (e.g. check a role
  // on their profile via the JWT) before allowing overrides. Left as a clear
  // TODO so it isn't silently insecure.
  // const adminOk = await isAdmin(event.headers.authorization); if(!adminOk) return 403...

  const { action } = body;

  if (action === 'assign') {
    const r = await assignForPlan(body.userId, body.plan, body.source || 'manual', body.oldPlan || null);
    return { statusCode: r.ok ? 200 : 400, headers: HDR, body: JSON.stringify(r) };
  }

  if (action === 'set_override') {
    const r = await setOverride(body.userId, body.feature, body.enabled, body.reason, body.by || 'admin');
    return { statusCode: r.ok ? 200 : 400, headers: HDR, body: JSON.stringify(r) };
  }

  return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Unknown action' }) };
};

exports.assignForPlan = assignForPlan;
exports.setOverride = setOverride;
