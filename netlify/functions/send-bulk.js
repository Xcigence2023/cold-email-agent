// Bulk campaign sender with scheduling support
// Sends in parallel batches of 20, supports SendGrid scheduled delivery

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
  if(!_rate(_rlip, 20, 60000)) return {statusCode:429, headers, body:JSON.stringify({error:'Too many requests. Please slow down.'})};
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SENDGRID_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'SENDGRID_API_KEY not configured' }) };

  // Verify user
  const token = (event.headers.authorization || '').replace('Bearer ', '');
  let userId = null;
  if (token && SUPABASE_URL && SERVICE_KEY) {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'Authorization': `Bearer ${token}`, 'apikey': SERVICE_KEY }
      });
      const u = await r.json();
      userId = u.id || null;
    } catch(e) {}
  }

  let emails, fromEmail, fromName, scheduleAt, campaignName;
  try {
    const body = JSON.parse(event.body);
    emails     = body.emails || [];
    fromEmail  = body.fromEmail || '';
    fromName   = body.fromName || 'Velorah';
    scheduleAt = body.scheduleAt || null; // ISO string or null
    campaignName = body.campaignName || 'Campaign ' + new Date().toLocaleDateString();
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!emails.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No emails provided' }) };
  if (!fromEmail)     return { statusCode: 400, headers, body: JSON.stringify({ error: 'No sender email' }) };

  // Convert scheduleAt to Unix timestamp for SendGrid (must be within 72 hours)
  let sendAt = null;
  if (scheduleAt) {
    const schedDate = new Date(scheduleAt);
    const now = new Date();
    const maxDate = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    if (schedDate > now && schedDate <= maxDate) {
      sendAt = Math.floor(schedDate.getTime() / 1000);
    }
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const results = { sent: 0, failed: 0, scheduled: 0, messageIds: {}, errors: [] };
  const BATCH = 20;

  const optOutPattern = /unsubscribe|opt.?out|remove (you|me)|take (you|me) off|reply stop|stop receiving|not relevant.{0,30}reply|reply.{0,30}remove/i;

  async function sendOne(ed) {
    if (!ed.to || !emailRegex.test(ed.to)) return { id: ed.id, success: false, error: 'Invalid email: ' + ed.to };

    let bodyText = ed.body || '';
    if (bodyText && !optOutPattern.test(bodyText)) {
      bodyText = bodyText + '\n\nIf this is not relevant, just reply and I will remove you from my list.';
    }

    const htmlBody = (bodyText)
      .split('\n\n')
      .map(p => `<p style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333">${p.replace(/\n/g,'<br>')}</p>`)
      .join('');

    const payload = {
      personalizations: [{ to: [{ email: ed.to }], subject: ed.subject }],
      from: { email: fromEmail, name: fromName },
      reply_to: { email: fromEmail, name: fromName },
      content: [
        { type: 'text/plain', value: bodyText || '' },
        { type: 'text/html', value: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#fff;max-width:600px;font-family:Arial,sans-serif">${htmlBody}<hr style="margin-top:32px;border:none;border-top:1px solid #eee"><p style="font-size:11px;color:#aaa;margin-top:12px">Sent by ${fromName} (${fromEmail}). Reply "Unsubscribe" to opt out.</p></body></html>` }
      ],
      tracking_settings: {
        click_tracking: { enable: true, enable_text: false },
        open_tracking: { enable: true },
        subscription_tracking: { enable: false }
      }
    };

    // Add schedule time if provided
    if (sendAt) payload.send_at = sendAt;

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.status >= 200 && res.status < 300) {
      return { id: ed.id, success: true, scheduled: !!sendAt, messageId: res.headers.get('x-message-id') || ed.id };
    }
    const err = await res.text();
    return { id: ed.id, success: false, error: `SG ${res.status}: ${err}` };
  }

  // Send in parallel batches
  for (let i = 0; i < emails.length; i += BATCH) {
    const batch = emails.slice(i, i + BATCH);
    const batchRes = await Promise.allSettled(batch.map(sendOne));

    batchRes.forEach(r => {
      if (r.status === 'fulfilled' && r.value.success) {
        if (r.value.scheduled) results.scheduled++;
        else results.sent++;
        if (r.value.messageId) results.messageIds[r.value.id] = r.value.messageId;
      } else {
        results.failed++;
        const err = r.status === 'rejected' ? r.reason?.message : r.value?.error;
        if (err) results.errors.push(err);
      }
    });

    // Update Supabase progress
    if (userId && SUPABASE_URL && SERVICE_KEY) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ leads_used_this_month: results.sent + results.scheduled })
        });
      } catch(e) {}
    }

    if (i + BATCH < emails.length) await new Promise(r => setTimeout(r, 150));
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      total: emails.length,
      sent: results.sent,
      scheduled: results.scheduled,
      failed: results.failed,
      messageIds: results.messageIds,
      errors: results.errors.slice(0, 5),
      scheduledFor: scheduleAt || null
    })
  };
};
