// Check if emails already exist in previous campaigns
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

  const token = (event.headers.authorization || '').replace('Bearer ', '');
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  // Verify user
  const uResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': SERVICE_KEY }
  });
  const uData = await uResp.json();
  if (!uResp.ok || !uData.id) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };

  let emails;
  try { ({ emails } = JSON.parse(event.body)); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!emails || !emails.length) return { statusCode: 200, headers, body: JSON.stringify({ duplicates: {} }) };

  // Query email_sends table for any of these emails
  const emailList = emails.map(e => `"${e}"`).join(',');
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/email_sends?user_id=eq.${uData.id}&recipient_email=in.(${emailList})&select=recipient_email,campaign_name,sent_at,status,tracking_status&order=sent_at.desc`,
    { headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY } }
  );

  const rows = await resp.json();
  const duplicates = {};
  if (Array.isArray(rows)) {
    rows.forEach(row => {
      if (!duplicates[row.recipient_email]) {
        duplicates[row.recipient_email] = {
          campaignName: row.campaign_name,
          sentAt: row.sent_at,
          status: row.status,
          tracking: row.tracking_status
        };
      }
    });
  }

  return { statusCode: 200, headers, body: JSON.stringify({ duplicates, total: Object.keys(duplicates).length }) };
};
