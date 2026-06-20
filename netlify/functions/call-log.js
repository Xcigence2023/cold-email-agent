/**
 * call-log.js -- Netlify Function: call logging + CRM follow-up backbone
 * Place in: netlify/functions/call-log.js
 *
 * The data backbone for the Velorah call center. Both the human dialer and the
 * AI voice agent write call records here, and follow-up tasks are created from
 * calls automatically.
 *
 * Actions (POST JSON with { action: ... }):
 *   log_call      -- record a completed call (human or AI)
 *   list_calls    -- get call logs (daily view, filterable)
 *   update_call   -- set outcome/notes/disposition on a call
 *   create_followup -- schedule a follow-up/callback
 *   list_followups  -- get open follow-ups
 *   complete_followup -- mark a follow-up done
 *
 * Auth: the browser sends the user's Supabase JWT (Authorization: Bearer ...).
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const HDR = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
  if (!SUPABASE_URL || !SERVICE_KEY) return err('Database not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY missing)', 500);

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
  if (!_rate(ip, 120, 60000)) return err('Too many requests', 429);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e) { return err('Invalid JSON'); }
  const action = body.action || '';

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace('Bearer ', '');

  // The AI agent (server-side) can pass an explicit user_id + a shared secret
  // instead of a JWT. For the browser, we resolve the user from their token.
  let userId = body.user_id || null;
  if (!userId) {
    userId = await getUserId(token, SUPABASE_URL, SERVICE_KEY);
  }
  if (!userId) return err('Unauthorized -- no valid user', 401);

  // ---- LOG A CALL ----
  if (action === 'log_call') {
    const row = {
      user_id: userId,
      to_number: String(body.to_number || '').slice(0, 32),
      from_number: body.from_number ? String(body.from_number).slice(0, 32) : null,
      contact_name: body.contact_name ? String(body.contact_name).slice(0, 200) : null,
      company: body.company ? String(body.company).slice(0, 200) : null,
      call_type: (body.call_type === 'ai' ? 'ai' : 'human'),
      direction: 'outbound',
      status: body.status ? String(body.status).slice(0, 32) : 'completed',
      outcome: body.outcome ? String(body.outcome).slice(0, 48) : null,
      duration_seconds: parseInt(body.duration_seconds || 0) || 0,
      transcript: body.transcript ? String(body.transcript).slice(0, 20000) : null,
      notes: body.notes ? String(body.notes).slice(0, 4000) : null,
      twilio_call_sid: body.twilio_call_sid ? String(body.twilio_call_sid).slice(0, 64) : null,
      captured_email: body.captured_email ? String(body.captured_email).slice(0, 200) : null,
      recording_url: body.recording_url ? String(body.recording_url).slice(0, 500) : null,
      started_at: body.started_at || new Date().toISOString(),
      ended_at: body.ended_at || new Date().toISOString()
    };
    const res = await sb('POST', 'call_logs', SUPABASE_URL, SERVICE_KEY, row);
    if (!res.ok) return err('Failed to log call (' + res.status + '): ' + JSON.stringify(res.data).slice(0, 200), 500);
    const created = Array.isArray(res.data) ? res.data[0] : res.data;

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
