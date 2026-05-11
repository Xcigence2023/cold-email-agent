// netlify/functions/check-plan.js
// Validates user session and returns their plan + usage

const { createClient } = require('@supabase/supabase-js');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

const PLAN_LIMITS = {
  free: 50,
  starter: 500,
  growth: 2000,
  pro: 10000,
  enterprise: -1  // unlimited
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };

  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session' }) };

  const { data: profile } = await supabase
    .from('profiles')
    .select('plan, leads_used_this_month, leads_limit, plan_renewed_at')
    .eq('id', user.id)
    .single();

  const plan = profile?.plan || 'free';
  const used = profile?.leads_used_this_month || 0;
  const limit = profile?.leads_limit || PLAN_LIMITS[plan] || 50;
  const canGenerate = limit === -1 || used < limit;

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      plan,
      used,
      limit,
      canGenerate,
      remaining: limit === -1 ? 'unlimited' : Math.max(0, limit - used)
    })
  };
};
