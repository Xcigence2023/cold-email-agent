/**
 * send.js - Optimized email sending
 * - Input validation and sanitization
 * - Rate limited: 100 sends/minute per sender
 * - Payload size limits
 * - Secure headers
 */

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const rateLimitStore = new Map();

function checkRate(id, max, windowMs) {
  const now = Date.now();
  const rec = rateLimitStore.get(id) || { count: 0, resetAt: now + windowMs };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + windowMs; }
  rec.count++;
  rateLimitStore.set(id, rec);
  return rec.count <= max;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Payload size check (max 10MB for attachments)
  if (event.body && event.body.length > 10 * 1024 * 1024) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'Payload too large. Max 10MB.' }) };
  }

  const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
  if (!SENDGRID_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email service not configured' }) };

  let to, subject, body, fromEmail, fromName, attachments;
  try {
    const parsed = JSON.parse(event.body || '{}');
    to          = String(parsed.to || '').trim().toLowerCase().substring(0, 255);
    subject     = String(parsed.subject || '').substring(0, 200).replace(/[<>]/g, '');
    body        = String(parsed.body || '').substring(0, 50000);
    fromEmail   = String(parsed.fromEmail || '').trim().toLowerCase().substring(0, 255);
    fromName    = String(parsed.fromName || 'Velorah').substring(0, 100).replace(/[<>]/g, '');
    attachments = Array.isArray(parsed.attachments) ? parsed.attachments.slice(0, 5) : [];
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  // Validate emails
  if (!EMAIL_RX.test(to))        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid recipient email: ' + to }) };
  if (!EMAIL_RX.test(fromEmail)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid sender email: ' + fromEmail }) };
  if (!subject || !body)         return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing subject or body' }) };

  // Rate limit by sender email: 100/minute
  if (!checkRate('send_' + fromEmail, 100, 60000)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many emails sent. Please wait.' }) };
  }

  // Build HTML
  const htmlBody = body.split('\n\n')
    .map(p => '<p style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333">' +
              p.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>') + '</p>')
    .join('');

  const payload = {
    personalizations: [{ to: [{ email: to }], subject }],
    from: { email: fromEmail, name: fromName },
    reply_to: { email: fromEmail, name: fromName },
    content: [
      { type: 'text/plain', value: body },
      { type: 'text/html', value: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:20px;background:#fff;max-width:600px">${htmlBody}<p style="margin-top:32px;font-size:11px;color:#999;border-top:1px solid #eee;padding-top:16px">Sent by ${fromName.replace(/</g,'').replace(/>/g,'')} (${fromEmail}). Reply "Unsubscribe" to opt out.</p></body></html>` }
    ],
    tracking_settings: {
      click_tracking: { enable: true, enable_text: false },
      open_tracking: { enable: true },
      subscription_tracking: { enable: false }
    }
  };

  // Validate and add attachments
  if (attachments.length) {
    payload.attachments = attachments
      .filter(a => a.base64 && a.name && typeof a.name === 'string')
      .map(a => ({
        content: String(a.base64),
        type: String(a.type || 'application/octet-stream').substring(0, 100),
        filename: String(a.name).replace(/[^a-zA-Z0-9._\-\s]/g, '').substring(0, 200),
        disposition: 'attachment'
      }));
  }

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.status >= 200 && res.status < 300) {
      const msgId = res.headers.get('x-message-id') || Date.now().toString(36);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, messageId: msgId }) };
    }
    const errText = await res.text();
    return { statusCode: res.status, headers, body: JSON.stringify({ error: 'Send failed: ' + res.status, detail: errText.substring(0, 200) }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Network error: ' + e.message }) };
  }
};
