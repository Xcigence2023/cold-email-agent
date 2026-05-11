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
    // Verify user
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': SERVICE_KEY }
    });
    const userData = await userResp.json();
    if (!userResp.ok || !userData.id) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };
    }

    const userId = userData.id;

    // GET — return user's saved keys
    if (event.httpMethod === 'GET') {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${userId}&select=anthropic_key,sendgrid_key,sender_name,sender_email,sender_title,sender_company`,
        {
          headers: {
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'apikey': SERVICE_KEY
          }
        }
      );
      const rows = await resp.json();
      return { statusCode: 200, headers, body: JSON.stringify({ keys: rows[0] || null }) };
    }

    // POST — save user's keys
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');

      // Check if row exists
      const checkResp = await fetch(
        `${SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${userId}&select=id`,
        { headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY } }
      );
      const existing = await checkResp.json();

      const payload = {
        user_id: userId,
        anthropic_key: body.anthropic_key || '',
        sendgrid_key: body.sendgrid_key || '',
        sender_name: body.sender_name || '',
        sender_email: body.sender_email || '',
        sender_title: body.sender_title || '',
        sender_company: body.sender_company || 'Velorah',
        updated_at: new Date().toISOString()
      };

      let saveResp;
      if (existing && existing.length > 0) {
        // Update existing
        saveResp = await fetch(
          `${SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${userId}`,
          {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${SERVICE_KEY}`,
              'apikey': SERVICE_KEY,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify(payload)
          }
        );
      } else {
        // Insert new
        saveResp = await fetch(
          `${SUPABASE_URL}/rest/v1/user_api_keys`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${SERVICE_KEY}`,
              'apikey': SERVICE_KEY,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify(payload)
          }
        );
      }

      if (!saveResp.ok) {
        const errText = await saveResp.text();
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save: ' + errText }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
