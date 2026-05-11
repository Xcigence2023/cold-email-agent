// netlify/functions/user-keys.js
// GET  → returns user's saved API keys and sender config
// POST → saves user's API keys and sender config

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // Get user from JWT
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) return { statusCode: 401, headers, body: JSON.stringify({ error: 'No authorization header' }) };

  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Verify user
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired session' }) };

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase
      .from('user_api_keys')
      .select('anthropic_key, sendgrid_key, sender_name, sender_email, sender_title, sender_company')
      .eq('user_id', user.id)
      .single();

    if (error && error.code !== 'PGRST116') {
      return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ keys: data || null }) };
  }

  if (event.httpMethod === 'POST') {
    const body = JSON.parse(event.body || '{}');
    const { anthropic_key, sendgrid_key, sender_name, sender_email, sender_title, sender_company } = body;

    const { error } = await supabase
      .from('user_api_keys')
      .upsert({
        user_id: user.id,
        anthropic_key,
        sendgrid_key,
        sender_name,
        sender_email,
        sender_title,
        sender_company,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });

    if (error) return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
