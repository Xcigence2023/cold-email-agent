// email_history.js — uses native fetch only, no npm dependencies

// Rate limiter
const _rl=new Map();
function _rate(id,max,win){const n=Date.now();const r=_rl.get(id)||{c:0,t:n+(win||60000)};if(n>r.t){r.c=0;r.t=n+(win||60000);}r.c++;_rl.set(id,r);return r.c<=(max||60);}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing Supabase config' }) };
  }

  // NOTE: `token` must be declared BEFORE the rate limiter reads it.
  // (Previously the rate-limit line ran first and referenced `token` in its
  // temporal dead zone, crashing every request with a ReferenceError.)
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const _rlip = token.substring(0, 20) || 'anon';
  if (!_rate(_rlip, 120, 60000)) return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests. Please slow down.' }) };

  // Verify user from JWT
  const uResp = await fetch((SUPABASE_URL) + '/auth/v1/user', {
    headers: { 'Authorization': 'Bearer ' + (token), 'apikey': SERVICE_KEY }
  });
  const uData = await uResp.json();
  if (!uResp.ok || !uData.id) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
  }
  const userId = uData.id;

  // GET — fetch email history
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const limit  = parseInt(params.limit  || '100');
    const offset = parseInt(params.offset || '0');
    const status   = params.status   || '';
    const tracking = params.tracking || '';
    const search   = params.search   || '';

    let url = (SUPABASE_URL) + '/rest/v1/email_sends'
      + '?user_id=eq.' + (userId)
      + '&order=sent_at.desc'
      + '&limit=' + (limit) + '&offset=' + (offset)
      + '&select=id,campaign_name,recipient_name,recipient_email,company,title,industry,subject,status,tracking_status,sent_at,scheduled_at,opened_at,clicked_at,message_id,open_count';
    if (status)   url += '&status=eq.' + (status);
    if (tracking) url += '&tracking_status=eq.' + (tracking);
    if (search) {
      url += '&or=(recipient_email.ilike.*' + (encodeURIComponent(search)) + '*,recipient_name.ilike.*' + (encodeURIComponent(search)) + '*,company.ilike.*' + (encodeURIComponent(search)) + '*)';
    }

    const resp = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + (SERVICE_KEY),
        'apikey': SERVICE_KEY,
        'Prefer': 'count=exact'
      }
    });
    const data = await resp.json();
    const range = resp.headers.get('content-range') || '';
    const total = parseInt(range.split('/')[1] || '0');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ records: Array.isArray(data) ? data : [], total })
    };
  }

  // POST — save sent emails to history
  if (event.httpMethod === 'POST') {
    let records;
    try { ({ records } = JSON.parse(event.body || '{}')); }
    catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
    if (!records || !records.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No records provided' }) };
    }

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

    const saveResp = await fetch((SUPABASE_URL) + '/rest/v1/email_sends', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + (SERVICE_KEY),
        'apikey': SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(rows)
    });
    if (!saveResp.ok) {
      const err = await saveResp.text();
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Save failed: ' + err }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, saved: rows.length }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
