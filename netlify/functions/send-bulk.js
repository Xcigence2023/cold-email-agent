// Bulk campaign sender with scheduling support
// Sends immediately via ZeptoMail, or -- for scheduled campaigns -- writes
// to the email_sends queue table for the scheduled-send worker to pick up.
// (Migrated from SendGrid's send_at, which ZeptoMail's API has no
// equivalent for. See supabase-migration-zeptomail-scheduling.sql and
// process-scheduled-emails.js for the other two pieces of this.)

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

  const ZEPTOMAIL_API_KEY = process.env.ZEPTOMAIL_API_KEY;
  const ZEPTOMAIL_API_URL = process.env.ZEPTOMAIL_API_URL || 'https://api.zeptomail.com/v1.1/email';
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!ZEPTOMAIL_API_KEY) {
    console.error('[send-bulk] BULK-CONFIG: ZEPTOMAIL_API_KEY missing');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Sending is temporarily unavailable. If this keeps happening, mention error code BULK-CONFIG.', code: 'BULK-CONFIG' }) };
  }

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

  let emails, fromEmail, fromName, scheduleAt, campaignName, attachments;
  try {
    const body = JSON.parse(event.body);
    emails     = body.emails || [];
    fromEmail  = body.fromEmail || '';
    fromName   = body.fromName || 'Velorah';
    scheduleAt = body.scheduleAt || null; // ISO string or null
    campaignName = body.campaignName || 'Campaign ' + new Date().toLocaleDateString();
    attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 5) : [];
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!emails.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No emails provided' }) };
  if (!userId && emails.some(e => e && e.bodyHtml)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Please sign in to send designed emails.', code: 'BULK-AUTH' }) };
  }
  if (!fromEmail)     return { statusCode: 400, headers, body: JSON.stringify({ error: 'No sender email' }) };

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const optOutPattern = /unsubscribe|opt.?out|remove (you|me)|take (you|me) off|reply stop|stop receiving|not relevant.{0,30}reply|reply.{0,30}remove/i;

  function buildBodies(ed) {
    const stripTags = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const optOutLine = 'If this is not relevant, just reply and I will remove you from my list.';
    let bodyText, htmlBody, fullDoc = false;
    if (ed.bodyHtml) {
      // A complete designed email (from the template designer) is sent exactly as designed:
      // no second wrapper, and any missing opt-out line goes inside its <body>.
      fullDoc = /^\s*(<!doctype|<html)/i.test(ed.bodyHtml);
      const plainCheck = stripTags(String(ed.bodyHtml).replace(/<head[\s\S]*?<\/head>/i, ''));
      htmlBody = ed.bodyHtml;
      if (plainCheck && !optOutPattern.test(plainCheck)) {
        const line = `<p style="margin:16px 0 0 0;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333">${optOutLine}</p>`;
        htmlBody = fullDoc ? htmlBody.replace(/<\/body>/i, line + '</body>') : htmlBody + line;
      }
      bodyText = (fullDoc && ed.body) ? String(ed.body) : plainCheck + (plainCheck && !optOutPattern.test(plainCheck) ? '\n\n' + optOutLine : '');
    } else {
      bodyText = ed.body || '';
      if (bodyText && !optOutPattern.test(bodyText)) bodyText = bodyText + '\n\n' + optOutLine;
      htmlBody = bodyText
        .split('\n\n')
        .map(p => `<p style="margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333">${p.replace(/\n/g,'<br>')}</p>`)
        .join('');
    }
    return { bodyText, htmlBody, fullDoc };
  }

  function pickAttachments(ed) {
    const src = (Array.isArray(ed.attachments) && ed.attachments.length) ? ed.attachments : attachments;
    return (src || [])
      .filter(a => a && a.base64 && a.name && typeof a.name === 'string')
      .slice(0, 5)
      .map(a => ({
        base64: String(a.base64),
        type: String(a.type || 'application/octet-stream').substring(0, 100),
        name: String(a.name).replace(/[^a-zA-Z0-9._\-\s]/g, '').substring(0, 200),
      }));
  }

  // ── SCHEDULED PATH: write to the queue instead of sending now ──────────
  if (scheduleAt) {
    const schedDate = new Date(scheduleAt);
    const now = new Date();
    const maxDate = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    if (!(schedDate > now && schedDate <= maxDate)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'scheduleAt must be in the future and within 72 hours' }) };
    }
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Scheduling is unavailable: server storage not configured.', code: 'BULK-SCHED-CONFIG' }) };
    }

    const rows = [];
    const errors = [];
    for (const ed of emails) {
      if (!ed.to || !emailRegex.test(ed.to)) { errors.push('Invalid email: ' + ed.to); continue; }
      const { bodyText, htmlBody } = buildBodies(ed);
      rows.push({
        user_id: userId,
        campaign_name: campaignName,
        recipient_name: ed.name || null,
        recipient_email: ed.to,
        company: ed.company || null,
        title: ed.title || null,
        industry: ed.industry || null,
        subject: ed.subject || '',
        body: htmlBody,
        from_email: fromEmail,
        from_name: fromName,
        attachments: pickAttachments(ed),
        status: 'scheduled',
        scheduled_at: schedDate.toISOString(),
      });
    }

    if (!rows.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No valid recipients to schedule', errors }) };

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/email_sends`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'apikey': SERVICE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify(rows),
      });
      if (!res.ok) {
        const t = await res.text();
        console.error('[send-bulk] BULK-SCHED-DB: ' + res.status + ': ' + t.slice(0, 300));
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not save scheduled campaign.', code: 'BULK-SCHED-DB' }) };
      }
    } catch (err) {
      console.error('[send-bulk] BULK-SCHED-DB: ' + err.message);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not save scheduled campaign.', code: 'BULK-SCHED-DB' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        total: emails.length,
        sent: 0,
        scheduled: rows.length,
        failed: errors.length,
        errors: errors.slice(0, 5),
        scheduledFor: schedDate.toISOString(),
      }),
    };
  }

  // ── IMMEDIATE PATH: send right now via ZeptoMail ────────────────────────
  const results = { sent: 0, failed: 0, scheduled: 0, messageIds: {}, errors: [] };
  const BATCH = 20;

  async function sendOne(ed) {
    if (!ed.to || !emailRegex.test(ed.to)) return { id: ed.id, success: false, error: 'Invalid email: ' + ed.to };
    const { bodyText, htmlBody, fullDoc } = buildBodies(ed);
    const thisAttachments = pickAttachments(ed);

    const fullHtml = fullDoc ? htmlBody : `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#fff;max-width:600px;font-family:Arial,sans-serif">${htmlBody}<hr style="margin-top:32px;border:none;border-top:1px solid #eee"><p style="font-size:11px;color:#aaa;margin-top:12px">Sent by ${fromName} (${fromEmail}). Reply "Unsubscribe" to opt out.</p></body></html>`;

    const payload = {
      from: { address: fromEmail, name: fromName },
      to: [{ email_address: { address: ed.to } }],
      reply_to: [{ address: fromEmail, name: fromName }],
      subject: ed.subject,
      htmlbody: fullHtml,
      textbody: bodyText || '',
      track_clicks: true,
      track_opens: true,
    };
    if (thisAttachments.length) {
      payload.attachments = thisAttachments.map(a => ({ content: a.base64, mime_type: a.type, name: a.name }));
    }

    let res;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        res = await fetch(ZEPTOMAIL_API_URL, {
          method: 'POST',
          headers: { 'Authorization': ZEPTOMAIL_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      console.error('[send-bulk] BULK-ZM-NET: ' + ed.to + ': ' + err.message);
      return { id: ed.id, success: false, error: 'Could not send to this address (code BULK-ZM-NET)' };
    }

    const text = await res.text();
    if (res.status >= 200 && res.status < 300) {
      let messageId = ed.id;
      try { messageId = JSON.parse(text).request_id || ed.id; } catch {}
      return { id: ed.id, success: true, scheduled: false, messageId };
    }
    console.error('[send-bulk] BULK-ZM: ZeptoMail ' + res.status + ' for ' + ed.to + ': ' + text.slice(0, 300));
    return { id: ed.id, success: false, error: 'Could not send to this address (code BULK-ZM-' + res.status + ')' };
  }

  for (let i = 0; i < emails.length; i += BATCH) {
    const batch = emails.slice(i, i + BATCH);
    const batchRes = await Promise.allSettled(batch.map(sendOne));

    batchRes.forEach(r => {
      if (r.status === 'fulfilled' && r.value.success) {
        results.sent++;
        if (r.value.messageId) results.messageIds[r.value.id] = r.value.messageId;
      } else {
        results.failed++;
        const err = r.status === 'rejected' ? r.reason?.message : r.value?.error;
        if (err) results.errors.push(err);
      }
    });

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
      scheduledFor: null
    })
  };
};
