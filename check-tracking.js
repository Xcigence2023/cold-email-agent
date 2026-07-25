// Checks email open/click status from SendGrid Activity API.
//
// IMPORTANT: this reports 'unknown' whenever the status genuinely could
// not be determined (SendGrid API error, network failure, malformed
// response) -- it must NEVER default an unverified email to 'delivered'.
// A previous version of this file did exactly that (defaulted to
// 'delivered' whenever the SendGrid call itself failed), which meant a
// SendGrid outage, rate limit, or auth problem silently reported every
// email as successfully delivered. That made the tracking status
// unreliable for exactly the cases where it mattered most -- something
// was actually wrong. 'unknown' is the honest answer when we don't know.

const _rl=new Map();
function _rate(id,max,win){const n=Date.now();const r=_rl.get(id)||{c:0,t:n+(win||60000)};if(n>r.t){r.c=0;r.t=n+(win||60000);}r.c++;_rl.set(id,r);return r.c<=(max||60);}

const HDR = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff'
};

// Customers never see raw internal errors -- short code only. Full detail
// goes to the function log for whoever's debugging it.
function safeFail(statusCode, code, detail) {
  if (detail) console.error('[check-tracking] ' + code + ': ' + detail);
  return { statusCode, headers: HDR, body: JSON.stringify({ error: 'Something went wrong. If this keeps happening, mention error code ' + code + '.', code }) };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };

  const _rlip = event.headers['x-forwarded-for']||'unknown';
  if(!_rate(_rlip, 30, 60000)) return safeFail(429, 'TRK-RATE');
  if (event.httpMethod !== 'POST') return safeFail(405, 'TRK-METHOD');

  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  if (!SENDGRID_API_KEY) return safeFail(500, 'TRK-CONFIG', 'SENDGRID_API_KEY missing');

  let emails;
  try {
    ({ emails } = JSON.parse(event.body)); // Array of { email, messageId }
  } catch(e) {
    return safeFail(400, 'TRK-JSON');
  }
  if (!Array.isArray(emails) || !emails.length) return { statusCode: 200, headers: HDR, body: JSON.stringify({ results: {} }) };

  const results = {};
  const failures = []; // tracked internally for logging, never sent to the client

  for (const item of emails.slice(0, 500)) {
    if (!item || !item.email) continue;
    try {
      const query = `to_email=${encodeURIComponent(item.email)}&limit=5`;
      const res = await fetch(`https://api.sendgrid.com/v3/messages?${query}`, {
        headers: {
          'Authorization': `Bearer ${SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      if (!res.ok) {
        // Genuinely don't know -- SendGrid's own status check failed.
        // This must not be reported as 'delivered'.
        results[item.email] = 'unknown';
        failures.push(item.email + ': SG status ' + res.status);
        continue;
      }

      const data = await res.json();
      const messages = data.messages || [];

      if (messages.length === 0) {
        results[item.email] = 'pending';
        continue;
      }

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
      } else if (status === 'dropped' || status === 'deferred') {
        results[item.email] = status; // don't paper over a real delivery problem as generic 'sent'
      } else {
        results[item.email] = 'sent';
      }
    } catch(e) {
      results[item.email] = 'unknown';
      failures.push(item.email + ': ' + e.message);
    }
  }

  if (failures.length) console.error('[check-tracking] ' + failures.length + ' lookups failed: ' + failures.slice(0, 10).join('; '));

  return { statusCode: 200, headers: HDR, body: JSON.stringify({ results }) };
};
