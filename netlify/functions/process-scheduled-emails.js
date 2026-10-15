// Scheduled Netlify Function — runs on a cron schedule (see netlify.toml)
// and sends any email in the email_sends queue whose scheduled_at has
// arrived. This is the piece that replaces SendGrid's built-in send_at
// scheduling, since ZeptoMail's API has no equivalent -- Velorah Ignition
// now owns the scheduling itself via Supabase + this worker.

exports.handler = async function (event) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ZEPTOMAIL_API_KEY = process.env.ZEPTOMAIL_API_KEY;
  const ZEPTOMAIL_API_URL = process.env.ZEPTOMAIL_API_URL || 'https://api.zeptomail.com/v1.1/email';

  if (!SUPABASE_URL || !SERVICE_KEY || !ZEPTOMAIL_API_KEY) {
    console.error('[process-scheduled-emails] SCHED-CONFIG: missing SUPABASE_URL / SUPABASE_SERVICE_KEY / ZEPTOMAIL_API_KEY');
    return { statusCode: 500, body: 'Not configured' };
  }

  // Pull a batch of due, scheduled emails. LIMIT keeps each run bounded so
  // this can't run past Netlify's function timeout even with a large backlog
  // -- any leftovers just get picked up on the next scheduled run.
  const nowIso = new Date().toISOString();
  let due;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/email_sends?status=eq.scheduled&scheduled_at=lte.${encodeURIComponent(nowIso)}&order=scheduled_at.asc&limit=50`,
      { headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY } }
    );
    if (!res.ok) throw new Error('query failed: ' + res.status);
    due = await res.json();
  } catch (err) {
    console.error('[process-scheduled-emails] SCHED-QUERY: ' + err.message);
    return { statusCode: 500, body: 'Query failed' };
  }

  if (!due.length) return { statusCode: 200, body: JSON.stringify({ processed: 0 }) };

  let sent = 0, failed = 0;

  for (const row of due) {
    // Claim the row first (status -> 'sending') so a slow run and the next
    // scheduled run can't both pick up and double-send the same email.
    try {
      const claim = await fetch(`${SUPABASE_URL}/rest/v1/email_sends?id=eq.${row.id}&status=eq.scheduled`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY,
          'Content-Type': 'application/json', 'Prefer': 'return=representation',
        },
        body: JSON.stringify({ status: 'sending', attempts: (row.attempts || 0) + 1 }),
      });
      const claimed = await claim.json();
      if (!claimed || !claimed.length) continue; // another run already claimed it
    } catch (err) {
      console.error('[process-scheduled-emails] SCHED-CLAIM: ' + row.id + ': ' + err.message);
      continue;
    }

    const attachments = Array.isArray(row.attachments) ? row.attachments : [];
    const payload = {
      from: { address: row.from_email, name: row.from_name || row.from_email },
      to: [{ email_address: { address: row.recipient_email } }],
      reply_to: [{ address: row.from_email, name: row.from_name || row.from_email }],
      subject: row.subject || '',
      htmlbody: row.body || '',
      textbody: (row.body || '').replace(/<head[\s\S]*?<\/head>/i, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      track_clicks: true,
      track_opens: true,
    };
    if (attachments.length) {
      payload.attachments = attachments.map(a => ({ content: a.base64, mime_type: a.type, name: a.name }));
    }

    let outcome = { ok: false, error: null, messageId: null };
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      let res;
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
      const text = await res.text();
      if (res.status >= 200 && res.status < 300) {
        let messageId = null;
        try { messageId = JSON.parse(text).request_id || null; } catch {}
        outcome = { ok: true, error: null, messageId };
      } else {
        outcome = { ok: false, error: 'ZeptoMail ' + res.status + ': ' + text.slice(0, 300), messageId: null };
      }
    } catch (err) {
      const isTimeout = err && err.name === 'AbortError';
      outcome = { ok: false, error: isTimeout ? 'timed out' : err.message, messageId: null };
    }

    try {
      await fetch(`${SUPABASE_URL}/rest/v1/email_sends?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify(
          outcome.ok
            ? { status: 'sent', sent_at: new Date().toISOString(), message_id: outcome.messageId }
            : { status: 'failed', error: outcome.error }
        ),
      });
    } catch (err) {
      console.error('[process-scheduled-emails] SCHED-UPDATE: ' + row.id + ': ' + err.message);
    }

    if (outcome.ok) sent++; else { failed++; console.error('[process-scheduled-emails] SCHED-SEND: ' + row.id + ': ' + outcome.error); }
  }

  return { statusCode: 200, body: JSON.stringify({ processed: due.length, sent, failed }) };
};
