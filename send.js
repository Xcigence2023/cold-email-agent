exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Migrated from SendGrid to ZeptoMail. ZEPTOMAIL_API_KEY must include the
  // "Zoho-enczapikey " prefix exactly as shown in ZeptoMail's dashboard
  // (Mail Agent > Setup > Send Mail Token) -- same convention used by the
  // marketing site's contact form function.
  const ZEPTOMAIL_API_KEY = process.env.ZEPTOMAIL_API_KEY;
  const ZEPTOMAIL_API_URL = process.env.ZEPTOMAIL_API_URL || 'https://api.zeptomail.com/v1.1/email';
  if (!ZEPTOMAIL_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ZEPTOMAIL_API_KEY not configured' }) };

  let to, subject, body, fromEmail, fromName, attachments;
  try {
    ({ to, subject, body, fromEmail, fromName, attachments } = JSON.parse(event.body));
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!to || !emailRegex.test(to)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid TO email: ' + to }) };
  if (!fromEmail || !emailRegex.test(fromEmail)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid FROM email: ' + fromEmail }) };
  if (!subject || !body) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing subject or body' }) };

  const htmlBody = body
    .split('\n\n')
    .map(p => `<p style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:20px 20px 40px;background:#fff;max-width:600px">${htmlBody}<p style="margin-top:32px;font-size:12px;color:#999;border-top:1px solid #eee;padding-top:16px">Sent by ${fromName || 'Velorah'} (${fromEmail}). Reply "Unsubscribe" to opt out.</p></body></html>`;

  const payload = {
    from: { address: fromEmail, name: fromName || 'Velorah' },
    to: [{ email_address: { address: to } }],
    reply_to: [{ address: fromEmail, name: fromName || 'Velorah' }],
    subject,
    htmlbody: fullHtml,
    textbody: body,
    track_clicks: true,
    track_opens: true,
  };

  if (attachments && attachments.length > 0) {
    payload.attachments = attachments.slice(0, 5).map(a => ({
      content: a.base64,
      mime_type: a.type || 'application/octet-stream',
      name: a.name,
    }));
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(ZEPTOMAIL_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': ZEPTOMAIL_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const text = await res.text();
    if (res.status >= 200 && res.status < 300) {
      let messageId = `velorah-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      try {
        const parsed = JSON.parse(text);
        messageId = parsed.request_id || messageId;
      } catch {}
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, messageId }) };
    }
    return { statusCode: res.status, headers, body: JSON.stringify({ error: 'ZeptoMail error ' + res.status + ': ' + text.slice(0, 300) }) };
  } catch (err) {
    const isTimeout = err && err.name === 'AbortError';
    return { statusCode: 502, headers, body: JSON.stringify({ error: isTimeout ? 'ZeptoMail request timed out' : (err.message || 'Network error') }) };
  }
};
