exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { to, subject, body, fromEmail, fromName, apiKey, attachments, replyTo } = JSON.parse(event.body);

    if (!to || !subject || !body || !fromEmail || !apiKey) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: to, subject, body, fromEmail, apiKey' }) };
    }

    // Convert plain text to simple HTML for better deliverability
    const htmlBody = body
      .split('\n\n')
      .map(p => `<p style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333">${p.replace(/\n/g,'<br>')}</p>`)
      .join('');

    const payload = {
      personalizations: [{
        to: [{ email: to }],
        subject
      }],
      from: { email: fromEmail, name: fromName },
      reply_to: { email: replyTo || fromEmail, name: fromName },
      content: [
        // Plain text first (important for spam filters)
        { type: 'text/plain', value: body },
        // HTML version
        { type: 'text/html', value: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:20px;background:#fff">${htmlBody}</body></html>` }
      ],
      // Mail settings for deliverability
      mail_settings: {
        bypass_list_management: { enable: false },
        footer: { enable: false },
        sandbox_mode: { enable: false }
      },
      // Tracking - disable open/click tracking to avoid spam filters
      tracking_settings: {
        click_tracking: { enable: false, enable_text: false },
        open_tracking: { enable: false },
        subscription_tracking: { enable: false }
      }
    };

    // Add attachments if any
    if (attachments && attachments.length > 0) {
      payload.attachments = attachments.slice(0, 5).map(a => ({
        content: a.base64,
        type: a.type || 'application/octet-stream',
        filename: a.name,
        disposition: 'attachment'
      }));
    }

    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (res.status >= 200 && res.status < 300) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    const text = await res.text();
    return { statusCode: res.status, headers, body: JSON.stringify({ error: 'SendGrid error ' + res.status + ': ' + text }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
