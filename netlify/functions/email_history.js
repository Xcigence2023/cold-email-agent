// email_history.js — uses native fetch only, no npm dependencies
//
// GET   -- fetch email history
// POST  -- save newly-sent emails to history
// PATCH -- update tracking_status (and opened_at/clicked_at) for existing
//          records. This did not exist before: check-tracking.js results
//          were only ever applied to the in-memory list in history.html,
//          never written back to the database, so the "real" status shown
//          after a page reload was whatever was saved at send time (always
//          'pending' at first) -- not what actually happened to the email.

const _rl=new Map();
function _rate(id,max,win){const n=Date.now();const r=_rl.get(id)||{c:0,t:n+(win||60000)};if(n>r.t){r.c=0;r.t=n+(win||60000);}r.c++;_rl.set(id,r);return r.c<=(max||60);}

function safeFail(headers, statusCode, code, detail) {
  if (detail) console.error('[email_history] ' + code + ': ' + detail);
  return { statusCode, headers, body: JSON.stringify({ error: 'Something went wrong. If this keeps happening, mention error code ' + code + '.', code }) };
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return safeFail(headers, 500, 'HIST-CONFIG', 'Missing Supabase config');

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return safeFail(headers, 401, 'HIST-AUTH');

  const _rlip = token.substring(0, 20) || 'anon';
  if (!_rate(_rlip, 120, 60000)) return safeFail(headers, 429, 'HIST-RATE');

  let userId;
  try {
    const uResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'Authorization': 'Bearer ' + token, 'apikey': SERVICE_KEY }
    });
    const uData = await uResp.json();
    if (!uResp.ok || !uData.id) return safeFail(headers, 401, 'HIST-AUTH', 'invalid session');
    userId = uData.id;
  } catch (e) {
    return safeFail(headers, 502, 'HIST-AUTHFETCH', e.message);
  }

  // ---- GET — fetch email history ----
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const limit  = parseInt(params.limit  || '100');
    const offset = parseInt(params.offset || '0');
    const status   = params.status   || '';
    const tracking = params.tracking || '';
    const search   = params.search   || '';

    let url = SUPABASE_URL + '/rest/v1/email_sends'
      + '?user_id=eq.' + userId
      + '&order=sent_at.desc'
      + '&limit=' + limit + '&offset=' + offset
      + '&select=id,campaign_name,recipient_name,recipient_email,company,title,industry,subject,status,tracking_status,sent_at,scheduled_at,opened_at,clicked_at,message_id,open_count';
    if (status)   url += '&status=eq.' + encodeURIComponent(status);
    if (tracking) url += '&tracking_status=eq.' + encodeURIComponent(tracking);
    if (search) {
      url += '&or=(recipient_email.ilike.*' + encodeURIComponent(search) + '*,recipient_name.ilike.*' + encodeURIComponent(search) + '*,company.ilike.*' + encodeURIComponent(search) + '*)';
    }

    try {
      const resp = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + SERVICE_KEY, 'apikey': SERVICE_KEY, 'Prefer': 'count=exact' }
      });
      if (!resp.ok) return safeFail(headers, 502, 'HIST-GET', 'status ' + resp.status);
      const data = await resp.json();
      const range = resp.headers.get('content-range') || '';
      const total = parseInt(range.split('/')[1] || '0');
      return { statusCode: 200, headers, body: JSON.stringify({ records: Array.isArray(data) ? data : [], total }) };
    } catch (e) {
      return safeFail(headers, 502, 'HIST-GETFETCH', e.message);
    }
  }

  // ---- POST — save sent emails to history ----
  if (event.httpMethod === 'POST') {
    let records;
    try { ({ records } = JSON.parse(event.body || '{}')); }
    catch (e) { return safeFail(headers, 400, 'HIST-JSON'); }
    if (!records || !records.length) return safeFail(headers, 400, 'HIST-NORECORDS');

    const rows = records.map(r => ({
      user_id:          userId,
      campaign_name:    r.campaignName || 'Campaign',
      recipient_name:   r.name         || '',
      recipient_email:  r.email        || '',
      company:          r.company      || '',
      title:            r.title        || '',
      industry:         r.industry     || '',
      subject:          r.subject      || '',
      body:             r.body         || '',
      status:           r.status       || 'sent',
      tracking_status:  'pending',
      message_id:       r.messageId    || null,
      sent_at:          r.scheduledAt  ? null : new Date().toISOString(),
      scheduled_at:     r.scheduledAt  || null,
      open_count:       0
    }));

    try {
      const saveResp = await fetch(SUPABASE_URL + '/rest/v1/email_sends', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + SERVICE_KEY,
          'apikey': SERVICE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(rows)
      });
      if (!saveResp.ok) {
        const t = await saveResp.text();
        return safeFail(headers, 502, 'HIST-SAVE', 'status ' + saveResp.status + ': ' + t.slice(0, 300));
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, saved: rows.length }) };
    } catch (e) {
      return safeFail(headers, 502, 'HIST-SAVEFETCH', e.message);
    }
  }

  // ---- PATCH — persist real tracking status (from check-tracking.js) ----
  // Body: { updates: [{ id, trackingStatus, openedAt?, clickedAt? }] }
  // Each update is scoped to this user's own rows (id + user_id filter),
  // so one user can never overwrite another's history record.
  if (event.httpMethod === 'PATCH') {
    let updates;
    try { ({ updates } = JSON.parse(event.body || '{}')); }
    catch (e) { return safeFail(headers, 400, 'HIST-JSON'); }
    if (!Array.isArray(updates) || !updates.length) return safeFail(headers, 400, 'HIST-NOUPDATES');

    let applied = 0;
    const failedIds = [];
    for (const u of updates.slice(0, 1000)) {
      if (!u || !u.id || !u.trackingStatus) continue;
      const patch = { tracking_status: String(u.trackingStatus).slice(0, 32) };
      if (u.trackingStatus === 'opened' && !u.skipOpenedAt) patch.opened_at = u.openedAt || new Date().toISOString();
      if (u.trackingStatus === 'clicked') patch.clicked_at = u.clickedAt || new Date().toISOString();
      try {
        const r = await fetch(
          SUPABASE_URL + '/rest/v1/email_sends?id=eq.' + encodeURIComponent(u.id) + '&user_id=eq.' + userId,
          {
            method: 'PATCH',
            headers: { 'Authorization': 'Bearer ' + SERVICE_KEY, 'apikey': SERVICE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify(patch)
          }
        );
        if (r.ok) applied++; else failedIds.push(u.id);
      } catch (e) {
        failedIds.push(u.id);
      }
    }
    if (failedIds.length) console.error('[email_history] PATCH failed for ' + failedIds.length + ' record(s): ' + failedIds.slice(0, 20).join(','));
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, applied, failed: failedIds.length }) };
  }

  return safeFail(headers, 405, 'HIST-METHOD');
};
