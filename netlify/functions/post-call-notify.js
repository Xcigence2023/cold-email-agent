/**
 * post-call-notify.js -- Netlify Function: AI-composed post-call email/SMS
 * Place in: netlify/functions/post-call-notify.js
 *
 * Reads a completed call's transcript from call_logs (written by
 * call-log.js) and drafts a follow-up email and, if consent allows, an SMS.
 * Composing and sending are separate actions on purpose: 'compose' only
 * ever writes a draft, 'send' is the one action that reaches an outside
 * inbox or phone, so it's the one action that re-checks consent fresh
 * against the current state of phone_numbers -- not whatever consent
 * looked like at call time (call_logs.consent_*_at_call), because a
 * contact can opt out at any point between the call ending and the
 * message going out, and TCPA/opt-out compliance has to hold at the
 * moment you actually contact them, not at the moment you drafted the
 * message.
 *
 * Actions (POST JSON with { action: ... }):
 *   compose  -- { call_id } -> draft an email, and an SMS if consented,
 *               from the call's transcript. Writes post_call_messages
 *               rows with status 'draft' or 'blocked'.
 *   send     -- { message_id } -> re-check consent, then actually send
 *               the draft. Writes status 'sent'/'failed'/'blocked'.
 *   list     -- { call_id } -> list messages drafted for a call.
 *
 * Auth: browser JWT, or voice-agent server calls with { user_id } +
 * X-Agent-Secret header (same pattern as call-log.js).
 *
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY, VOICE_AGENT_SHARED_SECRET,
 *      ANTHROPIC_API_KEY, ANTHROPIC_MODEL (optional, defaults below),
 *      SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, BUSINESS_NAME,
 *      BUSINESS_MAILING_ADDRESS (CAN-SPAM requires a physical address
 *      in every commercial email -- set this),
 *      TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 */

const HDR = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};
function ok(d){ return { statusCode: 200, headers: HDR, body: JSON.stringify(d) }; }
function err(m, c){ return { statusCode: c || 400, headers: HDR, body: JSON.stringify({ error: m }) }; }

function safeEqual(a, b){
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  try { return require('crypto').timingSafeEqual(bufA, bufB); }
  catch (e) { return false; }
}

async function getUserId(token, SUPABASE_URL, SERVICE_KEY){
  if (!token) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: SERVICE_KEY }
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  } catch (e) { return null; }
}

async function sb(method, path, SUPABASE_URL, SERVICE_KEY, body){
  const opts = {
    method,
    headers: {
      Authorization: 'Bearer ' + SERVICE_KEY,
      apikey: SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, opts);
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  return { ok: r.ok, status: r.status, data };
}

/* ---- Ask Claude to draft the follow-up, strictly as JSON ---- */
async function draftFromTranscript(call, wantSms){
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const sys = 'You write short, professional post-sales-call follow-up messages. '
    + 'Base everything strictly on the transcript provided -- never invent commitments, '
    + 'prices, or dates the contact did not actually agree to. '
    + 'Respond with ONLY a JSON object, no markdown fences, no preamble, matching exactly: '
    + '{"interest_level":"high|medium|low|none","interest_summary":"one sentence","next_step":"one sentence",'
    + '"email":{"subject":"...","body":"..."}' + (wantSms ? ',"sms":{"body":"..."}' : '') + '}. '
    + 'The email body should be plain text, 3-6 short sentences, no markdown.'
    + (wantSms ? ' The sms.body must be under 300 characters and stand alone -- do NOT include opt-out language, it will be appended automatically.' : '');

  const userMsg = 'Contact: ' + (call.contact_name || 'Unknown') + (call.company ? ' at ' + call.company : '')
    + '\nCall outcome (if logged): ' + (call.outcome || 'not set')
    + '\nDuration: ' + (call.duration_seconds || 0) + 's'
    + '\n\nTranscript:\n' + String(call.transcript || '').slice(0, 12000);

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      system: sys,
      messages: [{ role: 'user', content: userMsg }]
    })
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('Anthropic API error ' + resp.status + ': ' + t.slice(0, 300));
  }
  const data = await resp.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text in model response');
  let cleaned = textBlock.text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) { throw new Error('Model did not return valid JSON'); }
  return parsed;
}

function appendSmsOptOut(body, businessName){
  const suffix = ' -- Reply STOP to opt out.' + (businessName ? ' (' + businessName + ')' : '');
  let text = String(body || '').trim();
  const maxCore = 160 - suffix.length; // keep the whole thing in one SMS segment where possible
  if (text.length > maxCore) text = text.slice(0, Math.max(0, maxCore - 1)).trim() + '…';
  return text + suffix;
}

function appendEmailFooter(body, businessName, mailingAddress){
  const name = businessName || 'Our company';
  const addr = mailingAddress || '[mailing address not configured -- set BUSINESS_MAILING_ADDRESS]';
  return String(body || '').trim()
    + '\n\n---\n' + name + '\n' + addr
    + '\nIf you no longer wish to hear from us, reply to this email and let us know.';
}

// ============================================================
async function compose(userId, body, SUPABASE_URL, SERVICE_KEY){
  if (!body.call_id) return err('call_id required');

  const cres = await sb('GET',
    'call_logs?id=eq.' + encodeURIComponent(body.call_id) + '&user_id=eq.' + userId + '&limit=1',
    SUPABASE_URL, SERVICE_KEY);
  if (!cres.ok || !Array.isArray(cres.data) || !cres.data.length) return err('Call not found', 404);
  const call = cres.data[0];

  if (!call.transcript || !call.transcript.trim()) return err('This call has no transcript to compose from', 422);

  // Live consent check -- current state, not the at-call-time snapshot.
  let smsAllowed = false;
  if (call.number_id) {
    const nres = await sb('GET',
      'phone_numbers?id=eq.' + encodeURIComponent(call.number_id) + '&select=consent_sms,do_not_call&limit=1',
      SUPABASE_URL, SERVICE_KEY);
    if (nres.ok && Array.isArray(nres.data) && nres.data.length) {
      const n = nres.data[0];
      smsAllowed = !!n.consent_sms && !n.do_not_call;
    }
  }

  let drafted;
  try { drafted = await draftFromTranscript(call, smsAllowed); }
  catch (e) { return err('Could not draft follow-up: ' + e.message, 502); }

  // Fill in the AI's read of the call onto the call log itself, if not
  // already set by the voice agent.
  await sb('PATCH', 'call_logs?id=eq.' + encodeURIComponent(call.id), SUPABASE_URL, SERVICE_KEY, {
    interest_level: call.interest_level || drafted.interest_level || null,
    interest_summary: call.interest_summary || drafted.interest_summary || null,
    next_step: call.next_step || drafted.next_step || null
  });

  const businessName = process.env.BUSINESS_NAME || '';
  const drafts = [];

  if (drafted.email && call.captured_email) {
    const emailRow = {
      user_id: userId,
      call_id: call.id,
      channel: 'email',
      to_address: String(call.captured_email).slice(0, 200),
      subject: String(drafted.email.subject || 'Following up on our call').slice(0, 200),
      body: appendEmailFooter(drafted.email.body, businessName, process.env.BUSINESS_MAILING_ADDRESS).slice(0, 8000),
      status: 'draft'
    };
    const r = await sb('POST', 'post_call_messages', SUPABASE_URL, SERVICE_KEY, emailRow);
    if (r.ok) drafts.push(Array.isArray(r.data) ? r.data[0] : r.data);
  } else if (drafted.email && !call.captured_email) {
    drafts.push({ channel: 'email', status: 'blocked', block_reason: 'no_email_captured_for_contact' });
  }

  if (smsAllowed && drafted.sms && call.to_number) {
    const smsRow = {
      user_id: userId,
      call_id: call.id,
      channel: 'sms',
      to_address: call.to_number,
      subject: null,
      body: appendSmsOptOut(drafted.sms.body, businessName),
      status: 'draft'
    };
    const r = await sb('POST', 'post_call_messages', SUPABASE_URL, SERVICE_KEY, smsRow);
    if (r.ok) drafts.push(Array.isArray(r.data) ? r.data[0] : r.data);
  } else if (drafted.sms && !smsAllowed) {
    // Model was told not to draft SMS when !smsAllowed, so this is a
    // belt-and-suspenders path in case it ignored that instruction.
    const blockedRow = {
      user_id: userId,
      call_id: call.id,
      channel: 'sms',
      to_address: call.to_number || '',
      body: '(withheld -- no current SMS consent)',
      status: 'blocked',
      block_reason: 'no_sms_consent_or_opted_out'
    };
    const r = await sb('POST', 'post_call_messages', SUPABASE_URL, SERVICE_KEY, blockedRow);
    if (r.ok) drafts.push(Array.isArray(r.data) ? r.data[0] : r.data);
  }

  return ok({ ok: true, drafts, interest_level: drafted.interest_level, interest_summary: drafted.interest_summary, next_step: drafted.next_step });
}

// ============================================================
async function sendMessage(userId, body, SUPABASE_URL, SERVICE_KEY){
  if (!body.message_id) return err('message_id required');

  const mres = await sb('GET',
    'post_call_messages?id=eq.' + encodeURIComponent(body.message_id) + '&user_id=eq.' + userId + '&limit=1',
    SUPABASE_URL, SERVICE_KEY);
  if (!mres.ok || !Array.isArray(mres.data) || !mres.data.length) return err('Message not found', 404);
  const msg = mres.data[0];

  if (msg.status !== 'draft') return err('Message is not in draft state (status: ' + msg.status + ')', 409);

  if (msg.channel === 'sms') {
    // Fresh consent check, right before send.
    const nres = await sb('GET',
      'phone_numbers?user_id=eq.' + userId + '&phone_e164=eq.' + encodeURIComponent(msg.to_address) +
        '&select=consent_sms,do_not_call&limit=1',
      SUPABASE_URL, SERVICE_KEY);
    const n = (nres.ok && Array.isArray(nres.data) && nres.data[0]) || null;
    if (!n || !n.consent_sms || n.do_not_call) {
      await sb('PATCH', 'post_call_messages?id=eq.' + encodeURIComponent(msg.id), SUPABASE_URL, SERVICE_KEY,
        { status: 'blocked', block_reason: 'no_sms_consent_at_send_time' });
      return err('Blocked: no current SMS consent for this number', 403);
    }

    const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_PHONE_NUMBER;
    if (!sid || !tok || !from) return err('SMS sending not configured (Twilio env vars missing)', 500);
    try {
      const auth = Buffer.from(sid + ':' + tok).toString('base64');
      const params = new URLSearchParams({ To: msg.to_address, From: from, Body: msg.body });
      const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
        method: 'POST',
        headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const data = await r.json();
      if (!r.ok) {
        await sb('PATCH', 'post_call_messages?id=eq.' + encodeURIComponent(msg.id), SUPABASE_URL, SERVICE_KEY,
          { status: 'failed', block_reason: (data && data.message) || 'Twilio send failed' });
        return err('SMS send failed: ' + ((data && data.message) || r.status), 502);
      }
      const upd = await sb('PATCH', 'post_call_messages?id=eq.' + encodeURIComponent(msg.id), SUPABASE_URL, SERVICE_KEY,
        { status: 'sent', provider_id: data.sid || null, sent_at: new Date().toISOString() });
      return ok({ ok: true, message: Array.isArray(upd.data) ? upd.data[0] : upd.data });
    } catch (e) {
      await sb('PATCH', 'post_call_messages?id=eq.' + encodeURIComponent(msg.id), SUPABASE_URL, SERVICE_KEY,
        { status: 'failed', block_reason: e.message });
      return err('SMS send failed: ' + e.message, 502);
    }
  }

  if (msg.channel === 'email') {
    const key = process.env.SENDGRID_API_KEY, fromEmail = process.env.SENDGRID_FROM_EMAIL;
    if (!key || !fromEmail) return err('Email sending not configured (SENDGRID_API_KEY / SENDGRID_FROM_EMAIL missing)', 500);
    try {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: msg.to_address }] }],
          from: { email: fromEmail, name: process.env.BUSINESS_NAME || undefined },
          subject: msg.subject || 'Following up',
          content: [{ type: 'text/plain', value: msg.body }]
        })
      });
      if (!r.ok) {
        const t = await r.text();
        await sb('PATCH', 'post_call_messages?id=eq.' + encodeURIComponent(msg.id), SUPABASE_URL, SERVICE_KEY,
          { status: 'failed', block_reason: t.slice(0, 300) });
        return err('Email send failed: ' + r.status, 502);
      }
      const providerId = r.headers.get('x-message-id') || null;
      const upd = await sb('PATCH', 'post_call_messages?id=eq.' + encodeURIComponent(msg.id), SUPABASE_URL, SERVICE_KEY,
        { status: 'sent', provider_id: providerId, sent_at: new Date().toISOString() });
      return ok({ ok: true, message: Array.isArray(upd.data) ? upd.data[0] : upd.data });
    } catch (e) {
      await sb('PATCH', 'post_call_messages?id=eq.' + encodeURIComponent(msg.id), SUPABASE_URL, SERVICE_KEY,
        { status: 'failed', block_reason: e.message });
      return err('Email send failed: ' + e.message, 502);
    }
  }

  return err('Unknown channel: ' + msg.channel);
}

// ============================================================
async function list(userId, body, SUPABASE_URL, SERVICE_KEY){
  if (!body.call_id) return err('call_id required');
  const r = await sb('GET',
    'post_call_messages?user_id=eq.' + userId + '&call_id=eq.' + encodeURIComponent(body.call_id) + '&order=created_at.desc',
    SUPABASE_URL, SERVICE_KEY);
  if (!r.ok) return err('Failed to list messages', 500);
  return ok({ ok: true, messages: r.data || [] });
}

// ============================================================
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const AGENT_SECRET = process.env.VOICE_AGENT_SHARED_SECRET;
  if (!SUPABASE_URL || !SERVICE_KEY) return err('Database not configured', 500);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return err('Invalid JSON'); }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const agentSecretHeader = event.headers['x-agent-secret'] || event.headers['X-Agent-Secret'] || '';

  let userId = await getUserId(token, SUPABASE_URL, SERVICE_KEY);
  if (!userId && body.user_id) {
    if (!AGENT_SECRET || !safeEqual(agentSecretHeader, AGENT_SECRET)) return err('Unauthorized -- invalid agent secret', 401);
    userId = String(body.user_id);
  }
  if (!userId) return err('Unauthorized -- no valid user', 401);

  try {
    if (body.action === 'compose') return await compose(userId, body, SUPABASE_URL, SERVICE_KEY);
    if (body.action === 'send') return await sendMessage(userId, body, SUPABASE_URL, SERVICE_KEY);
    if (body.action === 'list') return await list(userId, body, SUPABASE_URL, SERVICE_KEY);
    return err('Unknown action: ' + body.action);
  } catch (e) {
    return err(e.message || 'Request failed', 500);
  }
};
