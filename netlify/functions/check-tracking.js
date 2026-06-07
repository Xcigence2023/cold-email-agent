// Checks email open/click status from SendGrid Activity API
// Rate limiter
const _rl=new Map();
function _rate(id,max,win){const n=Date.now();const r=_rl.get(id)||{c:0,t:n+(win||60000)};if(n>r.t){r.c=0;r.t=n+(win||60000);}r.c++;_rl.set(id,r);return r.c<=(max||60);}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const _rlip = event.headers['x-forwarded-for']||'unknown';
  if(!_rate(_rlip, 30, 60000)) return {statusCode:429, headers, body:JSON.stringify({error:'Too many requests. Please slow down.'})};
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  if (!SENDGRID_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'SENDGRID_API_KEY not configured' }) };

  let emails;
  try {
    ({ emails } = JSON.parse(event.body)); // Array of { email, messageId }
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  try {
    const results = {};

    // Query SendGrid Activity API for each email
    for (const item of emails) {
      try {
        const query = `to_email=${encodeURIComponent(item.email)}&limit=5`;
        const res = await fetch(`https://api.sendgrid.com/v3/messages?${query}`, {
          headers: {
            'Authorization': `Bearer ${SENDGRID_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        if (!res.ok) {
          results[item.email] = 'delivered';
          continue;
        }

        const data = await res.json();
        const messages = data.messages || [];

        if (messages.length === 0) {
          results[item.email] = 'pending';
          continue;
        }

        // Check status of most recent message
        const latest = messages[0];
        const status = latest.status || '';

        if (status === 'opened' || latest.opens_count > 0) {
          results[item.email] = 'opened';
        } else if (status === 'clicked' || latest.clicks_count > 0) {
          results[item.email] = 'clicked';
        } else if (status === 'delivered') {
          results[item.email] = 'delivered';
        } else if (status === 'bounced' || status === 'bounce') {
          results[item.email] = 'bounced';
        } else {
          results[item.email] = 'sent';
        }
      } catch(e) {
        results[item.email] = 'unknown';
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ results }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
