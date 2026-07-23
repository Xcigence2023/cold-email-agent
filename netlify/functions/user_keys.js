/**
 * user_keys.js - Optimized with caching and input validation
 * - Auth cached 5 min
 * - Keys response cached 10 min per user
 * - All inputs sanitized
 */
const authCache = new Map();
const keysCache = new Map();

async function getUser(token, url, key) {
  const k = token.substring(0, 40);
  const c = authCache.get(k);
  if (c && Date.now() < c.exp) return c.user;
  const r = await fetch(`${url}/auth/v1/user`, { headers: { 'Authorization': `Bearer ${token}`, 'apikey': key } });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u?.id) return null;
  authCache.set(k, { user: u, exp: Date.now() + 300000 });
  return u;
}

function san(v, max) { return String(v || '').replace(/[<>]/g, '').substring(0, max || 500); }
function sanEmail(v) { const e = String(v||'').trim().toLowerCase().substring(0, 255); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : ''; }

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

  const SB = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SB || !SK) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };

  // NOTE: `token` must be declared BEFORE the rate limiter uses it.
  // (Previously the rate-limit line ran first and referenced `token` in its
  // temporal dead zone, which crashed every request with a ReferenceError.)
  const token = (event.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const _rlip = token.substring(0, 20) || 'anon';
  if (!_rate(_rlip, 60, 60000)) return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests. Please slow down.' }) };

  const user = await getUser(token, SB, SK);
  if (!user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };

  // GET -- return cached keys
  if (event.httpMethod === 'GET') {
    const cacheKey = 'keys_' + user.id;
    const cached = keysCache.get(cacheKey);
    if (cached && Date.now() < cached.exp) {
      return { statusCode: 200, headers: { ...headers, 'X-Cache': 'HIT' }, body: JSON.stringify({ keys: cached.keys }) };
    }
    const r = await fetch(`${SB}/rest/v1/user_api_keys?user_id=eq.${user.id}&select=anthropic_key,sendgrid_key,sender_name,sender_email,sender_title,sender_company,hubspot_key,salesforce_key,salesforce_instance,pipedrive_key,zoho_key,zoho_dc,ghl_key,activecampaign_key,activecampaign_account,notion_key,notion_db_id,crm_active`, {
      headers: { 'Authorization': `Bearer ${SK}`, 'apikey': SK }
    });
    const rows = await r.json();
    const keys = rows?.[0] || null;
    keysCache.set(cacheKey, { keys, exp: Date.now() + 600000 }); // 10 min cache
    return { statusCode: 200, headers, body: JSON.stringify({ keys }) };
  }

  // POST -- save keys (invalidate cache)
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    // Sanitize all inputs
    const payload = {
      user_id:        user.id,
      sendgrid_key:   san(body.sendgrid_key, 200),
      sender_name:    san(body.sender_name, 100),
      sender_email:   sanEmail(body.sender_email),
      sender_title:   san(body.sender_title, 100),
      sender_company: san(body.sender_company, 100),
      updated_at:     new Date().toISOString(),
      hubspot_key:          san(body.hubspot_key, 200),
      salesforce_key:       san(body.salesforce_key, 500),
      salesforce_instance:  san(body.salesforce_instance, 200),
      pipedrive_key:        san(body.pipedrive_key, 200),
      zoho_key:             san(body.zoho_key, 500),
      zoho_dc:              san(body.zoho_dc, 20),
      ghl_key:              san(body.ghl_key, 200),
      activecampaign_key:   san(body.activecampaign_key, 200),
      activecampaign_account: san(body.activecampaign_account, 100),
      notion_key:           san(body.notion_key, 200),
      notion_db_id:         san(body.notion_db_id, 100),
      crm_active:           san(body.crm_active, 30),
    };

    // Validate sender email
    if (payload.sender_email && !sanEmail(payload.sender_email)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid sender email' }) };
    }

    // Check if exists
    const chk = await fetch(`${SB}/rest/v1/user_api_keys?user_id=eq.${user.id}&select=id`, {
      headers: { 'Authorization': `Bearer ${SK}`, 'apikey': SK }
    });
    const existing = await chk.json();
    const method = existing?.length > 0 ? 'PATCH' : 'POST';
    const url = existing?.length > 0
      ? `${SB}/rest/v1/user_api_keys?user_id=eq.${user.id}`
      : `${SB}/rest/v1/user_api_keys`;

    const saveRes = await fetch(url, {
      method,
      headers: { 'Authorization': `Bearer ${SK}`, 'apikey': SK, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(payload)
    });
    if (!saveRes.ok) {
      const e = await saveRes.text();
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Save failed', detail: e.substring(0, 100) }) };
    }

    // Invalidate cache
    keysCache.delete('keys_' + user.id);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
