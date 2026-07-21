/**
 * VELORAH — Feature gating in the UI (portal front-end)
 * Include after feature-config.js:  <script src="/feature-config.js"></script>
 *                                   <script src="/features-ui.js"></script>
 *
 * Reminder: UI hiding is a COURTESY, not security. The backend
 * (feature-access.js / assertFeature) is what actually protects features.
 * This just gives users a clean experience — hiding or "lock"-badging things
 * they can't use, and prompting an upgrade.
 *
 * Usage:
 *   await VelorahGate.load(session.access_token);   // fetch the user's access map
 *   VelorahGate.has('ai_voice');                    // -> true/false
 *   VelorahGate.applyDom();                          // process [data-feature] elements
 */
(function () {
  'use strict';

  var state = { plan: 'free', features: {}, availability: {}, limits: {}, catalog: {}, loaded: false };

  async function load(accessToken, endpoint) {
    endpoint = endpoint || '/.netlify/functions/feature-access';
    try {
      var res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (accessToken || '') },
        body: JSON.stringify({ action: 'map' }),
      });
      if (!res.ok) throw new Error('access map ' + res.status);
      var data = await res.json();
      state.plan = data.plan;
      state.features = data.features || {};
      state.availability = data.availability || {};
      state.limits = data.limits || {};
      state.catalog = data.catalog || {};
      state.loaded = true;
    } catch (e) {
      // Fail closed in the UI: if we can't load access, assume only free features.
      // (The backend still enforces regardless, so this is purely cosmetic.)
      state.loaded = false;
      if (window.VelorahFeatures) {
        var cfg = window.VelorahFeatures;
        Object.keys(cfg.FEATURES).forEach(function (k) {
          state.features[k] = cfg.planHasFeature('free', k);
          state.availability[k] = cfg.featureAvailability('free', k);
        });
      }
    }
    return state;
  }

  function has(featureKey) { return state.features[featureKey] === true; }
  function availabilityOf(featureKey) { return state.availability[featureKey] || 'locked'; }
  function plan() { return state.plan; }
  function limit(key) { var v = state.limits[key]; return v === -1 ? Infinity : v; }

  /**
   * Process every element with [data-feature="key"] in the DOM:
   *   - allowed        -> shown normally
   *   - add-on         -> shown, with a small "Add-on" badge
   *   - locked         -> either hidden, or shown disabled with a lock + upgrade,
   *                       controlled by [data-locked="hide"|"disable"] (default disable)
   */
  function applyDom(root) {
    root = root || document;
    var els = root.querySelectorAll('[data-feature]');
    els.forEach(function (el) {
      var key = el.getAttribute('data-feature');
      var avail = availabilityOf(key);
      var mode = el.getAttribute('data-locked') || 'disable';

      // clear previous state
      el.classList.remove('vf-locked', 'vf-addon');
      var existing = el.querySelector('.vf-badge'); if (existing) existing.remove();

      if (avail === 'included') {
        el.hidden = false;
        el.removeAttribute('aria-disabled');
        el.style.pointerEvents = '';
        el.style.opacity = '';
      } else if (avail === 'addon') {
        el.hidden = false;
        el.classList.add('vf-addon');
        el.appendChild(badge('Add-on', 'addon'));
      } else { // locked
        if (mode === 'hide') {
          el.hidden = true;
        } else {
          el.hidden = false;
          el.classList.add('vf-locked');
          el.setAttribute('aria-disabled', 'true');
          el.style.pointerEvents = 'none';
          el.style.opacity = '0.55';
          var need = requiredTier(key);
          el.appendChild(badge('🔒 ' + (need ? cap(need) : 'Upgrade'), 'locked'));
        }
      }
    });
  }

  function requiredTier(key) {
    if (window.VelorahFeatures && window.VelorahFeatures.FEATURES[key])
      return window.VelorahFeatures.FEATURES[key].minTier;
    return null;
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function badge(text, kind) {
    var b = document.createElement('span');
    b.className = 'vf-badge vf-badge-' + kind;
    b.textContent = text;
    b.style.cssText =
      'display:inline-flex;align-items:center;gap:.3em;margin-left:.5em;font-size:.7rem;font-weight:700;' +
      'padding:.15em .55em;border-radius:999px;vertical-align:middle;' +
      (kind === 'addon'
        ? 'background:rgba(245,158,11,.15);color:#B45309;'
        : 'background:rgba(109,40,217,.12);color:#6D28D9;');
    return b;
  }

  /**
   * Guard a click/action in the UI. Returns true if allowed; otherwise shows
   * an upgrade prompt (via onUpgrade callback or a default alert) and returns false.
   */
  function guard(featureKey, onUpgrade) {
    if (has(featureKey)) return true;
    var need = requiredTier(featureKey);
    var label = (state.catalog && state.catalog[featureKey]) || featureKey;
    if (typeof onUpgrade === 'function') onUpgrade({ feature: featureKey, label: label, upgradeTo: need });
    else alert(label + ' is available on the ' + cap(need || 'a higher') + ' plan. Upgrade to unlock it.');
    return false;
  }

  window.VelorahGate = {
    load: load, has: has, guard: guard, applyDom: applyDom,
    availabilityOf: availabilityOf, plan: plan, limit: limit,
    get state() { return state; },
  };
})();
