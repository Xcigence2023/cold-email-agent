/**
 * check_duplicates.js -- Netlify Function: check a list of emails against
 * this user's send history (email_sends), so they know before sending
 * whether they're about to re-contact someone from a past campaign.
 *
 * This function was referenced by app.html (POST /.netlify/functions/
 * check_duplicates) but never existed in the repo -- every "Check
 * Duplicates" click was silently 404ing. This is the missing function.
 *
 * POST { emails: string[] }
 * -> { total, duplicates: { "<email>": { campaignName, sentAt } } }
 *
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const HDR = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff'
};

const _rl = new Map();
function _rate(id, max, win) {
  const n = Date.now();
  const r = _rl.get(id) || { c: 0, t: n + (win || 60000) };
  if (n > r.t) { r.c = 0; r.t = n + (win || 60000); }
  r.c++; _rl.set(id, r);
  return r.c <= (max || 30);
}

// Customers never see raw internal errors (DB failures, missing config,
// stack traces). They get a short code; the real detail goes to the
// function log for whoever's debugging it.
function safeFail(statusCode, code, detail) {
  if (detail) console.error('[check_duplicates] ' + code + ': ' + detail);
  return { statusCode, headers: HDR, body: JSON.stringify({ error: 'Something went wrong. If this keeps happening, mention error code ' + code + '.', code }) };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };
  if (event.httpMethod !== 'POST') return safeFail(405, 'DUP-METHOD');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return safeFail(500, 'DUP-CONFIG', 'SUPABASE_URL/SUPABASE_SERVICE_KEY missing');

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return safeFail(401, 'DUP-AUTH');

  const rlId = token.slice(0, 20) || 'anon';
  if (!_rate(rlId, 30, 60000)) return safeFail(429, 'DUP-RATE');

  let userId;
  try {
    const uResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: SERVICE_KEY }
    });
    const uData = await uResp.json();
    if (!uResp.ok || !uData.id) return safeFail(401, 'DUP-AUTH', 'invalid session');
    userId = uData.id;
  } catch (e) {
    return safeFail(502, 'DUP-AUTHFETCH', e.message);
  }

  let emails;
  try {
    ({ emails } = JSON.parse(event.body || '{}'));
  } catch (e) {
    return safeFail(400, 'DUP-JSON');
  }
  if (!Array.isArray(emails) || !emails.length) return safeFail(400, 'DUP-NOEMAILS');

  const clean = emails
    .map(e => String(e || '').trim().toLowerCase())
    .filter(e => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    .slice(0, 5000); // hard cap -- this is a lookup, not a bulk export
  if (!clean.length) return { statusCode: 200, headers: HDR, body: JSON.stringify({ total: 0, duplicates: {} }) };

  try {
    // PostgREST 'in' filter, chunked to stay well under URL length limits.
    const CHUNK = 200;
    const duplicates = {};
    for (let i = 0; i < clean.length; i += CHUNK) {
      const chunk = clean.slice(i, i + CHUNK);
      const inList = chunk.map(e => '"' + e.replace(/"/g, '\\"') + '"').join(',');
      const url = SUPABASE_URL + '/rest/v1/email_sends'
        + '?user_id=eq.' + userId
        + '&recipient_email=in.(' + inList + ')'
        + '&select=recipient_email,campaign_name,sent_at'
        + '&order=sent_at.desc';
      const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + SERVICE_KEY, apikey: SERVICE_KEY } });
      if (!resp.ok) {
        const t = await resp.text();
        return safeFail(502, 'DUP-QUERY', 'status ' + resp.status + ': ' + t.slice(0, 200));
      }
      const rows = await resp.json();
      (rows || []).forEach(r => {
        const em = (r.recipient_email || '').toLowerCase();
        // Keep the most recent occurrence (rows are ordered sent_at.desc,
        // and this is the first/only time we set duplicates[em]).
        if (em && !duplicates[em]) {
          duplicates[em] = { campaignName: r.campaign_name || 'a previous campaign', sentAt: r.sent_at || null };
        }
      });
    }

    return { statusCode: 200, headers: HDR, body: JSON.stringify({ total: Object.keys(duplicates).length, duplicates }) };
  } catch (e) {
    return safeFail(502, 'DUP-UNEXPECTED', e.message);
  }
};
