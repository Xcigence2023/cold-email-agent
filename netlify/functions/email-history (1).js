// Get or save email send history from Supabase

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing Supabase config' }) };

  // Verify user
  const token = (event.headers.authorization || '').replace('Bearer ', '');
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const uResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': SERVICE_KEY }
  });
  const uData = await uResp.json();
  if (!uResp.ok || !uData.id)
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };

  const userId = uData.id;

  // GET — retrieve send history
  if (event.httpMethod === 'GET') {
    const params   = event.queryStringParameters || {};
    const limit    = parseInt(params.limit  || '100');
    const offset   = parseInt(params.offset || '0');
    const status   = params.status   || null;
    const campaign = params.campaign || null;
    const search   = params.search   || null;

    let url = `${SUPABASE_URL}/rest/v1/email_sends`
      + `?user_id=eq.${userId}`
      + `&order=sent_at.desc`
      + `&limit=${limit}&offset=${offset}`
      + `&select=id,campaign_name,recipient_name,recipient_email,company,subject,status,tracking_status,sent_at,scheduled_at,opened_at,clicked_at,message_id`;

    if (status)   url += `&status=eq.${status}`;
    if (campaign) url += `&campaign_name=ilike.*${encodeURIComponent(campaign)}*`;
    if (search)   url += `&or=(recipient_email.ilike.*${encodeURIComponent(search)}*,recipient_name.ilike.*${encodeURIComponent(search)}*,company.ilike.*${encodeURIComponent(search)}*)`;

    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'apikey': SERVICE_KEY,
        'Prefer': 'count=exact'
      }
    });
    const data = await resp.json();
    const total = resp.headers.get('content-range')?.split('/')?.[1] || 0;

    return { statusCode: 200, headers, body: JSON.stringify({ records: data || [], total: parseInt(total) }) };
  }

  // POST — save batch of sent emails to history
  if (event.httpMethod === 'POST') {
    let records;
    try {
      ({ records } = JSON.parse(event.body));
    } catch(e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    if (!records || !records.length)
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No records provided' }) };

    const rows = records.map(r => ({
      user_id:          userId,
      campaign_name:    r.campaignName || 'Campaign',
      recipient_name:   r.name || '',
      recipient_email:  r.email || '',
      company:          r.company || '',
      title:            r.title || '',
      industry:         r.industry || '',
      subject:          r.subject || '',
      body:             r.body || '',
      status:           r.status || 'sent',
      tracking_status:  'pending',
      message_id:       r.messageId || null,
      sent_at:          r.scheduledAt ? null : new Date().toISOString(),
      scheduled_at:     r.scheduledAt || null
    }));

    const saveResp = await fetch(`${SUPABASE_URL}/rest/v1/email_sends`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SERVICE_KEY}`,
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
