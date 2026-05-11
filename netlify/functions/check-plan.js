exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing Supabase env vars' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No authorization header' }) };

  try {
    // Get user from JWT
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SERVICE_KEY
      }
    });
    const userData = await userResp.json();
    if (!userResp.ok || !userData.id) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
    }

    // Get profile
    const profileResp = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userData.id}&select=plan,leads_used_this_month,leads_limit`,
      {
        headers: {
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'apikey': SERVICE_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    const profiles = await profileResp.json();
    const profile = profiles[0] || { plan: 'free', leads_used_this_month: 0, leads_limit: 50 };

    const plan = profile.plan || 'free';
    const used = profile.leads_used_this_month || 0;
    const limit = profile.leads_limit || 50;
    const canGenerate = limit === -1 || used < limit;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        plan, used, limit, canGenerate,
        remaining: limit === -1 ? 'unlimited' : Math.max(0, limit - used)
      })
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
