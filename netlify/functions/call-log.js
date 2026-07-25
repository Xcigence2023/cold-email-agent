/**
 * call-log.js -- Netlify Function: call logging + CRM follow-up backbone
 * Place in: netlify/functions/call-log.js
 *
 * The data backbone for the Velorah call center. Both the human dialer and the
 * AI voice agent write call records here, and follow-up tasks are created from
 * calls automatically.
 *
 * Actions (POST JSON with { action: ... }):
 *   log_call      -- record a completed call (human or AI). If a row for
 *                     this twilio_call_sid already exists (started via
 *                     append_note), merges into it rather than duplicating.
 *   append_note   -- capture a note WHILE a call is still in progress.
 *                     Upserts by twilio_call_sid so multiple notes across
 *                     one call accumulate onto a single row.
 *   list_calls    -- get call logs (daily view, filterable)
 *   update_call   -- set outcome/notes/disposition on a call
 *   create_followup -- schedule a follow-up/callback
 *   list_followups  -- get open follow-ups
 *   complete_followup -- mark a follow-up done
 *
 * Auth: the browser sends the user's Supabase JWT (Authorization: Bearer ...).
 * The voice agent (server-to-server, no user browser session) instead sends
 * body.user_id plus the X-Agent-Secret header, checked against
 * VOICE_AGENT_SHARED_SECRET.
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY, VOICE_AGENT_SHARED_SECRET
 */

const HDR = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Agent-Secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};
function ok(d){ return { statusCode: 200, headers: HDR, body: JSON.stringify(d) }; }
function err(m, c){ return { statusCode: c || 400, headers: HDR, body: JSON.stringify({ error: m }) }; }

// Simple rate limiter
const _rl = new Map();
function _rate(id, max, win){
  const n = Date.now();
  const r = _rl.get(id) || { c: 0, t: n + (win||60000) };
  if (n > r.t) { r.c = 0; r.t = n + (win||60000); }
  r.c++; _rl.set(id, r);
  return r.c <= (max||120);
}

// Constant-time string compare, to avoid leaking the shared secret via timing
function safeEqual(a, b){
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  try { return require('crypto').timingSafeEqual(bufA, bufB); }
  catch (e) { return false; }
}

// Resolve the user id from their Supabase JWT
async function getUserId(token, SUPABASE_URL, SERVICE_KEY){
  if (!token) return null;
  try {
    const r = await fetch((SUPABASE_URL) + '/auth/v1/user', {
      headers: { 'Authorization': 'Bearer ' + token, 'apikey': SERVICE_KEY }
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  } catch(e) { return null; }
}

// Supabase REST helper (service key bypasses RLS; we scope by user_id ourselves)
async function sb(method, path, SUPABASE_URL, SERVICE_KEY, body){
  const opts = {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + SERVICE_KEY,
      'apikey': SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=representation'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch((SUPABASE_URL) + '/rest/v1/' + path, opts);
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch(e) { data = txt; }
  return { ok: r.ok, status: r.status, data: data };
}

exports.handler = async function(event){
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const AGENT_SECRET = process.env.VOICE_AGENT_SHARED_SECRET;
  if (!SUPABASE_URL || !SERVICE_KEY) return err('Database not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY missing)', 500);

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
  if (!_rate(ip, 120, 60000)) return err('Too many requests', 429);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) { return err('Invalid JSON'); }
  const action = body.action || '';

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const agentSecretHeader = event.headers['x-agent-secret'] || event.headers['X-Agent-Secret'] || '';

  // Two ways in:
  //  1. Browser: Supabase JWT identifies the user. Always wins if present.
  //  2. Voice agent (server-to-server, no browser session): body.user_id is
  //     trusted ONLY if paired with a valid X-Agent-Secret. Without a
  //     correct secret, body.user_id is ignored outright -- it must never
  //     be trusted on its own, or any caller could write/read another
  //     user's call logs and follow-ups by supplying their user_id.
  let userId = await getUserId(token, SUPABASE_URL, SERVICE_KEY);
  if (!userId && body.user_id) {
    if (!AGENT_SECRET) return err('Voice agent auth not configured (VOICE_AGENT_SHARED_SECRET missing)', 500);
    if (!safeEqual(agentSecretHeader, AGENT_SECRET)) return err('Unauthorized -- invalid agent secret', 401);
    userId = String(body.user_id);
  }
  if (!userId) return err('Unauthorized -- no valid user', 401);

  // ---- APPEND A LIVE NOTE (call still in progress) ----
  // Lets the voice agent capture notes AS the call happens, not just at the
  // end. Upserts by twilio_call_sid: first call creates an 'in_progress'
  // row, later calls append to its notes. log_call (above/below) will find
  // and finish this same row rather than creating a duplicate.
  if (action === 'append_note') {
    const sid = body.twilio_call_sid ? String(body.twilio_call_sid).slice(0, 64) : null;
    if (!sid) return err('twilio_call_sid required');
    const note = body.note ? String(body.note).slice(0, 2000) : '';
    if (!note) return err('note required');

    const eres = await sb('GET',
      'call_logs?user_id=eq.' + userId + '&twilio_call_sid=eq.' + encodeURIComponent(sid) + '&limit=1',
      SUPABASE_URL, SERVICE_KEY);
    const existing = (eres.ok && Array.isArray(eres.data) && eres.data[0]) || null;

    const stamped = '[' + new Date().toISOString().slice(11, 19) + '] ' + note;

    if (existing) {
      const merged = (existing.notes ? existing.notes + '\n' : '') + stamped;
      const pres = await sb('PATCH', 'call_logs?id=eq.' + encodeURIComponent(existing.id), SUPABASE_URL, SERVICE_KEY,
        { notes: merged.slice(0, 4000) });
      if (!pres.ok) return err('Failed to append note', 500);
      return ok({ ok: true, call: Array.isArray(pres.data) ? pres.data[0] : pres.data });
    }

    const row = {
      user_id: userId,
      to_number: body.to_number ? String(body.to_number).slice(0, 32) : '',
      contact_name: body.contact_name ? String(body.contact_name).slice(0, 200) : null,
      company: body.company ? String(body.company).slice(0, 200) : null,
      call_type: (body.call_type === 'ai' ? 'ai' : 'human'),
      direction: 'outbound',
      status: 'in_progress',
      duration_seconds: 0,
      notes: stamped,
      twilio_call_sid: sid,
      started_at: body.started_at || new Date().toISOString(),
      ended_at: new Date().toISOString() // placeholder, overwritten when log_call finalizes
    };
    const res = await sb('POST', 'call_logs', SUPABASE_URL, SERVICE_KEY, row);
    if (!res.ok) return err('Failed to start call note (' + res.status + '): ' + JSON.stringify(res.data).slice(0, 200), 500);
    return ok({ ok: true, call: Array.isArray(res.data) ? res.data[0] : res.data });
  }

  // ---- LOG A CALL ----
  if (action === 'log_call') {
    const toNumber = String(body.to_number || '').slice(0, 32);

    // Look up the matching consent record and snapshot it onto the call
    // log as it stood AT CALL TIME. This is a snapshot, not a live join --
    // consent can change later (e.g. an opt-out the next day), and the
    // compliance record has to reflect what was true when the call
    // happened, not what's true when someone reads the log afterward.
    let numberRow = null;
    if (toNumber) {
      const nres = await sb(
        'GET',
        'phone_numbers?user_id=eq.' + userId + '&phone_e164=eq.' + encodeURIComponent(toNumber) +
          '&select=id,consent_call,consent_sms,consent_record,do_not_call&limit=1',
        SUPABASE_URL, SERVICE_KEY
      );
      if (nres.ok && Array.isArray(nres.data) && nres.data.length) numberRow = nres.data[0];
    }

    let complianceFlag = null;
    if (!numberRow) complianceFlag = 'no_consent_record_found';
    else if (numberRow.do_not_call) complianceFlag = 'called_despite_do_not_call';
    else if (body.call_type === 'ai' && !numberRow.consent_call) complianceFlag = 'no_call_consent_on_file';

    const row = {
      user_id: userId,
      to_number: toNumber,
      from_number: body.from_number ? String(body.from_number).slice(0, 32) : null,
      contact_name: body.contact_name ? String(body.contact_name).slice(0, 200) : null,
      company: body.company ? String(body.company).slice(0, 200) : null,
      call_type: (body.call_type === 'ai' ? 'ai' : 'human'),
      direction: 'outbound',
      status: body.status ? String(body.status).slice(0, 32) : 'completed',
      outcome: body.outcome ? String(body.outcome).slice(0, 48) : null,
      duration_seconds: parseInt(body.duration_seconds || 0) || 0,
      transcript: body.transcript ? String(body.transcript).slice(0, 20000) : null,
      twilio_call_sid: body.twilio_call_sid ? String(body.twilio_call_sid).slice(0, 64) : null,
      captured_email: body.captured_email ? String(body.captured_email).slice(0, 200) : null,
      recording_url: body.recording_url ? String(body.recording_url).slice(0, 500) : null,
      started_at: body.started_at || new Date().toISOString(),
      ended_at: body.ended_at || new Date().toISOString(),
      number_id: numberRow ? numberRow.id : null,
      answered_by: body.answered_by ? String(body.answered_by).slice(0, 16) : null,
      consent_call_at_call: numberRow ? !!numberRow.consent_call : false,
      consent_sms_at_call: numberRow ? !!numberRow.consent_sms : false,
      consent_record_at_call: numberRow ? !!numberRow.consent_record : false,
      recording_disclosed: body.recording_disclosed === true,
      compliance_flag: complianceFlag
    };

    // If a note-taking pass already started this call (see 'append_note'),
    // merge into that row instead of inserting a duplicate -- this is what
    // lets live notes taken mid-call survive into the final record even if
    // the agent only calls append_note and then log_call at the end, and
    // protects against ending up with two rows for one call if the agent
    // calls both.
    let existing = null;
    if (row.twilio_call_sid) {
      const eres = await sb('GET',
        'call_logs?user_id=eq.' + userId + '&twilio_call_sid=eq.' + encodeURIComponent(row.twilio_call_sid) + '&limit=1',
        SUPABASE_URL, SERVICE_KEY);
      if (eres.ok && Array.isArray(eres.data) && eres.data.length) existing = eres.data[0];
    }

    // New freeform notes from this call, appended to (not replacing)
    // whatever was accumulated live via append_note -- both the agent's
    // live notes and any final wrap-up note the caller sends here are kept.
    const incomingNotes = body.notes ? String(body.notes).slice(0, 4000) : '';
    const mergedNotes = existing && existing.notes
      ? (incomingNotes ? existing.notes + '\n' + incomingNotes : existing.notes)
      : (incomingNotes || null);
    row.notes = mergedNotes ? mergedNotes.slice(0, 4000) : null;

    let created;
    if (existing) {
      const pres = await sb('PATCH', 'call_logs?id=eq.' + encodeURIComponent(existing.id), SUPABASE_URL, SERVICE_KEY, row);
      if (!pres.ok) return err('Failed to update call (' + pres.status + '): ' + JSON.stringify(pres.data).slice(0, 200), 500);
      created = Array.isArray(pres.data) ? pres.data[0] : pres.data;
    } else {
      const res = await sb('POST', 'call_logs', SUPABASE_URL, SERVICE_KEY, row);
      if (!res.ok) return err('Failed to log call (' + res.status + '): ' + JSON.stringify(res.data).slice(0, 200), 500);
      created = Array.isArray(res.data) ? res.data[0] : res.data;
    }

    // Auto-create a follow-up if requested or implied by outcome
    let followup = null;
    if (body.followup_due_at || body.outcome === 'callback' || body.outcome === 'interested') {
      const fu = {
        user_id: userId,
        call_log_id: created ? created.id : null,
        to_number: row.to_number,
        contact_name: row.contact_name,
        company: row.company,
        followup_type: body.followup_type || (body.outcome === 'interested' ? 'meeting' : 'callback'),
        due_at: body.followup_due_at || new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        notes: body.followup_notes || ('Auto follow-up from ' + row.call_type + ' call'),
        status: 'open'
      };
      const fres = await sb('POST', 'call_followups', SUPABASE_URL, SERVICE_KEY, fu);
      if (fres.ok) followup = Array.isArray(fres.data) ? fres.data[0] : fres.data;
    }

    return ok({ ok: true, call: created, followup: followup });
  }

  // ---- LIST CALLS (daily log view) ----
  if (action === 'list_calls') {
    let q = 'call_logs?user_id=eq.' + userId + '&order=started_at.desc&limit=' + (parseInt(body.limit) || 200);
    if (body.outcome) q += '&outcome=eq.' + encodeURIComponent(body.outcome);
    if (body.call_type) q += '&call_type=eq.' + encodeURIComponent(body.call_type);
    if (body.since) q += '&started_at=gte.' + encodeURIComponent(body.since);
    const res = await sb('GET', q, SUPABASE_URL, SERVICE_KEY);
    if (!res.ok) return err('Failed to list calls', 500);
    return ok({ ok: true, calls: res.data || [] });
  }

  // ---- UPDATE A CALL (set outcome/notes) ----
  if (action === 'update_call') {
    if (!body.id) return err('call id required');
    const patch = {};
    if (body.outcome !== undefined) patch.outcome = String(body.outcome).slice(0, 48);
    if (body.notes !== undefined) patch.notes = String(body.notes).slice(0, 4000);
    if (body.status !== undefined) patch.status = String(body.status).slice(0, 32);
    const res = await sb('PATCH', 'call_logs?id=eq.' + encodeURIComponent(body.id) + '&user_id=eq.' + userId, SUPABASE_URL, SERVICE_KEY, patch);
    if (!res.ok) return err('Failed to update call', 500);
    return ok({ ok: true, call: Array.isArray(res.data) ? res.data[0] : res.data });
  }

  // ---- CREATE FOLLOW-UP ----
  if (action === 'create_followup') {
    const fu = {
      user_id: userId,
      call_log_id: body.call_log_id || null,
      to_number: body.to_number ? String(body.to_number).slice(0, 32) : null,
      contact_name: body.contact_name ? String(body.contact_name).slice(0, 200) : null,
      company: body.company ? String(body.company).slice(0, 200) : null,
      followup_type: body.followup_type || 'callback',
      due_at: body.due_at || new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      notes: body.notes ? String(body.notes).slice(0, 4000) : null,
      status: 'open'
    };
    const res = await sb('POST', 'call_followups', SUPABASE_URL, SERVICE_KEY, fu);
    if (!res.ok) return err('Failed to create follow-up', 500);
    return ok({ ok: true, followup: Array.isArray(res.data) ? res.data[0] : res.data });
  }

  // ---- LIST FOLLOW-UPS ----
  if (action === 'list_followups') {
    let q = 'call_followups?user_id=eq.' + userId + '&order=due_at.asc&limit=' + (parseInt(body.limit) || 200);
    if (body.status) q += '&status=eq.' + encodeURIComponent(body.status);
    else q += '&status=eq.open';
    const res = await sb('GET', q, SUPABASE_URL, SERVICE_KEY);
    if (!res.ok) return err('Failed to list follow-ups', 500);
    return ok({ ok: true, followups: res.data || [] });
  }

  // ---- COMPLETE FOLLOW-UP ----
  if (action === 'complete_followup') {
    if (!body.id) return err('followup id required');
    const res = await sb('PATCH', 'call_followups?id=eq.' + encodeURIComponent(body.id) + '&user_id=eq.' + userId, SUPABASE_URL, SERVICE_KEY, { status: body.status || 'done' });
    if (!res.ok) return err('Failed to update follow-up', 500);
    return ok({ ok: true, followup: Array.isArray(res.data) ? res.data[0] : res.data });
  }

  return err('Unknown action: ' + action);
};
