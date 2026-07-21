/**
 * VELORAH — Feature & Plan Configuration (single source of truth)
 * ---------------------------------------------------------------
 * This file defines which features and limits each subscription tier gets.
 * BOTH the backend (feature-access.js) and the frontend (features-ui.js)
 * import from here, so access is always consistent.
 *
 * To change what a plan includes: edit ONLY this file. Nothing else.
 *
 * Per-customer exceptions (early access, custom deals) are handled as
 * OVERRIDES stored in the database — see feature-overrides in the schema —
 * so you never need a code change for a one-off grant.
 */

// ---- The ordered tiers (low -> high). Order matters for "at least" checks. ----
const TIERS = ['free', 'starter', 'growth', 'pro', 'enterprise'];

// ---- Every feature in the product, with a stable key ----
// Keys are what you check in code, e.g. hasFeature(user, 'ai_voice')
const FEATURES = {
  // Core (everyone, including free)
  lead_discovery:      { label: 'Lead discovery',           minTier: 'free' },
  email_campaigns:     { label: 'AI email campaigns',       minTier: 'free' },
  crm:                 { label: 'Built-in CRM & pipeline',  minTier: 'free' },

  // Starter+
  email_enrichment:    { label: 'Contact enrichment',       minTier: 'starter' },
  attachments:         { label: 'Per-recipient attachments',minTier: 'starter' },
  ab_testing:          { label: 'A/B campaign testing',     minTier: 'starter' },

  // Growth+
  social_listening:    { label: 'Social & signal tracking', minTier: 'growth' },
  visitor_intel:       { label: 'Website visitor intel',    minTier: 'growth' },
  ai_voice:            { label: 'Consented AI voice agent', minTier: 'growth' }, // add-on at Growth, included at Pro
  call_center:         { label: 'Call center & dialing',    minTier: 'growth' },

  // Pro+
  ai_video:            { label: 'AI campaign video',        minTier: 'pro' },
  advanced_analytics:  { label: 'Advanced analytics',       minTier: 'pro' },
  priority_support:    { label: 'Priority support',         minTier: 'pro' },

  // Enterprise only
  sso:                 { label: 'SSO & access controls',    minTier: 'enterprise' },
  white_label:         { label: 'White-label / multi-tenant',minTier: 'enterprise' },
  dedicated_infra:     { label: 'Dedicated infrastructure', minTier: 'enterprise' },
  success_manager:     { label: 'Dedicated success manager',minTier: 'enterprise' },
};

// ---- Numeric limits per tier (matches the pricing model) ----
// -1 means unlimited. Usage is enforced separately by billing.js; these are the caps.
const LIMITS = {
  free:       { emails_per_month: 50,     lead_credits: 50,     mailboxes: 1,  seats: 1 },
  starter:    { emails_per_month: 1000,   lead_credits: 500,    mailboxes: 1,  seats: 1 },
  growth:     { emails_per_month: 10000,  lead_credits: 5000,   mailboxes: 3,  seats: 5 },
  pro:        { emails_per_month: 50000,  lead_credits: 25000,  mailboxes: 10, seats: 25 },
  enterprise: { emails_per_month: -1,     lead_credits: -1,     mailboxes: -1, seats: -1 },
};

// ---- Which tier "includes" a feature vs "offers it as a paid add-on" ----
// ai_voice is a Growth add-on but included from Pro up. This lets the UI say
// "Add-on" vs "Included" correctly.
const ADDONS = {
  ai_voice: { addonAtTier: 'growth', includedFromTier: 'pro' },
};

// ============================================================
// Pure helper logic (no I/O) — safe to run on server OR browser
// ============================================================

function tierRank(tier) {
  const i = TIERS.indexOf(tier);
  return i === -1 ? 0 : i; // unknown tier treated as lowest
}

/** Does `tier` meet or exceed `minTier`? */
function tierMeets(tier, minTier) {
  return tierRank(tier) >= tierRank(minTier);
}

/**
 * Core check: does this plan include this feature by default (no overrides)?
 * `plan` is a tier string like 'growth'.
 */
function planHasFeature(plan, featureKey) {
  const f = FEATURES[featureKey];
  if (!f) return false;              // unknown feature = deny (fail closed)
  return tierMeets(plan, f.minTier);
}

/**
 * Full resolution including per-customer overrides.
 * overrides: { [featureKey]: true | false }  (from the DB)
 *   true  = explicitly granted regardless of plan
 *   false = explicitly revoked regardless of plan
 */
function resolveFeature(plan, featureKey, overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, featureKey)) {
    return overrides[featureKey] === true;
  }
  return planHasFeature(plan, featureKey);
}

/** Whether a feature is an add-on the customer must enable (vs included). */
function featureAvailability(plan, featureKey) {
  const addon = ADDONS[featureKey];
  if (!addon) return planHasFeature(plan, featureKey) ? 'included' : 'locked';
  if (tierMeets(plan, addon.includedFromTier)) return 'included';
  if (tierMeets(plan, addon.addonAtTier)) return 'addon';
  return 'locked';
}

/** The list of feature keys a plan gets (respecting overrides). */
function featuresForPlan(plan, overrides = {}) {
  return Object.keys(FEATURES).filter(k => resolveFeature(plan, k, overrides));
}

/** Numeric limit for a plan (returns Infinity for unlimited). */
function limitFor(plan, key) {
  const row = LIMITS[plan] || LIMITS.free;
  const v = row[key];
  return v === -1 ? Infinity : (v ?? 0);
}

const _api = {
  TIERS, FEATURES, LIMITS, ADDONS,
  tierRank, tierMeets, planHasFeature, resolveFeature,
  featureAvailability, featuresForPlan, limitFor,
};

// Works in Node (backend functions) and browser (UI) and as an ES module.
if (typeof module !== 'undefined' && module.exports) module.exports = _api;
if (typeof window !== 'undefined') window.VelorahFeatures = _api;
