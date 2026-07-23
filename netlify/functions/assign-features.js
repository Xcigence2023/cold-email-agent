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
 * SECURITY: the HTTP handler is ADMIN-ONLY. The caller must present a valid
 * Supabase JWT whose email appears in the ADMIN_EMAILS env var. It fails CLOSED:
 * if ADMIN_EMAILS is unset/empty, or the token is missing/invalid, every request
 * is rejected. The exported functions below are NOT guarded, because they are
 * called server-side by trusted code (e.g. stripe-webhook.js) that never takes
 * a user's word for who they are.
 *
 * ENV:
 *   SUPABASE_URL          (required)
 *   SUPABASE_SERVICE_KEY  (required)
 *   ADMIN_EMAILS          (required for the HTTP handler) comma-separated list,
 *                         e.g. "you@velorahflow.io,ops@velorahflow.io"
 */

const CFG = require('./feature-config.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_EMAILS = process.env.ADMIN_EMAILS || '';

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

// ============================================================
// ADMIN AUTHORISATION
// ============================================================

/** Parse ADMIN_EMAILS into a normalised Set. Empty set = nobody is an admin. */
function adminEmailSet() {
  return new Set(
    ADMIN_EMAILS.split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Verify the caller is an admin.
 * Returns { ok:true, email, userId } or { ok:false, status, error }.
 * Fails closed on every error path.
 */
async function requireAdmin(authHeader) {
  const admins = adminEmailSet();
  if (admins.size === 0) {
    // No admins configured -> refuse everything rather than allow everything.
    return { ok: false, status: 503, error: 'Admin access is not configured.' };
  }

  if (!authHeader || !/^Bearer\s+.+/i.test(authHeader)) {
    return { ok: false, status: 401, error: 'Authentication required.' };
  }
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  // Reject the service key being used as a bearer token from the outside.
  if (SERVICE_KEY && token === SERVICE_KEY) {
    return { ok: false, status: 401, error: 'Invalid credentials.' };
  }

  let user;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SERVICE_KEY },
    });
    if (!res.ok) return { ok: false, status: 401, error: 'Invalid or expired session.' };
    user = await res.json();
  } catch (_) {
    return { ok: false, status: 401, error: 'Could not verify session.' };
  }

  const email = (user && user.email ? String(user.email) : '').trim().toLowerCase();
  if (!email || !user.id) {
    return { ok: false, status: 401, error: 'Invalid session.' };
  }
  if (!admins.has(email)) {
    // Deliberately vague: don't reveal who is or isn't an admin.
    return { ok: false, status: 403, error: 'Not authorised.' };
  }
  return { ok: true, email, userId: user.id };
}

// ============================================================
// CORE LOGIC (server-side; called inline by trusted code)
// ============================================================

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
  if (!userId) return { ok: false, error: 'missing userId' };
  if (!CFG.FEATURES[featureKey]) return { ok: false, error: 'unknown feature' };
  if (!(enabled === true || enabled === false || enabled === null)) {
    return { ok: false, error: 'enabled must be true, false, or null' };
  }

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

// ============================================================
// HTTP HANDLER — ADMIN ONLY
// ============================================================

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HDR, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: HDR, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!SUPABASE_URL || !SERVICE_KEY)
    return { statusCode: 500, headers: HDR, body: JSON.stringify({ error: 'Server not configured' }) };

  // ---- ADMIN GATE: nothing below runs unless the caller is a verified admin ----
  const auth = event.headers.authorization || event.headers.Authorization;
  const gate = await requireAdmin(auth);
  if (!gate.ok) {
    return { statusCode: gate.status, headers: HDR, body: JSON.stringify({ error: gate.error }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {
    return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { action } = body;

  if (action === 'assign') {
    const r = await assignForPlan(body.userId, body.plan, body.source || 'manual', body.oldPlan || null);
    return { statusCode: r.ok ? 200 : 400, headers: HDR, body: JSON.stringify(r) };
  }

  if (action === 'set_override') {
    // Record WHO made the change, from the verified token — not from the request body.
    const r = await setOverride(
      body.userId,
      body.feature,
      body.enabled === undefined ? null : body.enabled,
      body.reason,
      gate.email
    );
    return { statusCode: r.ok ? 200 : 400, headers: HDR, body: JSON.stringify(r) };
  }

  return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Unknown action' }) };
};

// Exported for trusted server-side callers (e.g. stripe-webhook.js).
// These are intentionally NOT admin-gated: the caller is our own backend code,
// not a user request.
exports.assignForPlan = assignForPlan;
exports.setOverride = setOverride;
exports.requireAdmin = requireAdmin;
