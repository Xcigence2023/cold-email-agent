exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  if (!SENDGRID_API_KEY) {
    console.error('[send] SEND-CONFIG: SENDGRID_API_KEY missing');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Sending is temporarily unavailable. If this keeps happening, mention error code SEND-CONFIG.', code: 'SEND-CONFIG' }) };
  }

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

  // Unique message ID for tracking
  const messageId = `velorah-${Date.now()}-${Math.random().toString(36).substr(2,9)}`;

  const payload = {
    personalizations: [{ to: [{ email: to }], subject }],
    from: { email: fromEmail, name: fromName || fromEmail },
    reply_to: { email: fromEmail, name: fromName || fromEmail },
    content: [
      { type: 'text/plain', value: body },
      { type: 'text/html', value: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:20px 20px 40px;background:#fff;max-width:600px">${htmlBody}<p style="margin-top:32px;font-size:12px;color:#999;border-top:1px solid #eee;padding-top:16px">Sent by ${fromName||fromEmail} (${fromEmail}). Reply "Unsubscribe" to opt out.</p></body></html>` }
    ],
    // Enable open tracking for analytics
    tracking_settings: {
      click_tracking: { enable: true, enable_text: false },
      open_tracking: { enable: true },
      subscription_tracking: { enable: false }
    },
    custom_args: { message_id: messageId }
  };

  if (attachments && attachments.length > 0) {
    payload.attachments = attachments.slice(0, 5).map(a => ({
      content: a.base64,
      type: a.type || 'application/octet-stream',
      filename: a.name,
      disposition: 'attachment'
    }));
  }

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.status >= 200 && res.status < 300) {
      // Get SendGrid message ID from response headers
      const sgMessageId = res.headers.get('x-message-id') || messageId;
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, messageId: sgMessageId }) };
    }
    const text = await res.text();
    console.error('[send] SEND-SG: SendGrid ' + res.status + ': ' + text.slice(0, 300));
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'This email could not be sent. If this keeps happening, mention error code SEND-SG.', code: 'SEND-SG' }) };
  } catch (err) {
    console.error('[send] SEND-FAIL: ' + err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'This email could not be sent. If this keeps happening, mention error code SEND-FAIL.', code: 'SEND-FAIL' }) };
  }
};
