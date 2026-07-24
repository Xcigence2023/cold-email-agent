/**
 * phone-list.js — Velorah Call Center: certified phone list upload / download
 * netlify/functions/phone-list.js
 *
 * Actions:
 *   'upload'    — store a phone list WITH a signed consent certification.
 *                 Refuses to store anything if the certification is incomplete.
 *   'download'  — export the user's numbers as CSV (includes consent state)
 *   'list'      — summary of the user's lists
 *   'suppress'  — mark a number do-not-call (opt-out)
 *
 * COMPLIANCE STANCE
 *   A number cannot enter the system without the uploader attesting to:
 *     - lawful acquisition of the number
 *     - consent to be CALLED
 *   SMS consent and RECORDING consent are captured separately, because
 *   TCPA treats them separately. Downstream dialling/texting checks these
 *   flags; there is no path that bypasses them.
 *
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const HDR = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'X-Content-Type-Options': 'nosniff'
};

const SB = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;

function sb(path, opts = {}) {
  return fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SK, Authorization: `Bearer ${SK}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
}

async function getUser(authHeader) {
  if (!authHeader) return null;
  const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const r = await fetch(`${SB}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: SK } });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch (_) { return null; }
}

/* ---- E.164 normalisation. Returns null if it cannot be made valid. ---- */
function toE164(raw, defaultCountry) {
  if (!raw) return null;
  let s = String(raw).trim();
  const hadPlus = s.charAt(0) === '+';
  s = s.replace(/[^\d]/g, '');
  if (!s) return null;
  if (hadPlus) return s.length >= 8 && s.length <= 15 ? '+' + s : null;
  const cc = (defaultCountry || 'US').toUpperCase();
  if (cc === 'US' || cc === 'CA') {
    if (s.length === 11 && s.charAt(0) === '1') return '+' + s;
    if (s.length === 10) return '+1' + s;
    return null;                       // ambiguous -> reject rather than guess
  }
  return s.length >= 8 && s.length <= 15 ? '+' + s : null;
}

/* ---- The certification gate. Everything else depends on this. ---- */
function validateCertification(c) {
  const problems = [];
  if (!c || typeof c !== 'object') return ['No certification supplied.'];
  if (!c.certifiedBy || !String(c.certifiedBy).trim()) problems.push('Name of the person certifying is required.');
  if (!c.certifiedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(c.certifiedEmail))) problems.push('A valid certifying email is required.');
  if (c.attestLawfulSource !== true) problems.push('You must confirm the numbers were obtained lawfully.');
  if (c.attestConsentCall !== true) problems.push('You must confirm you hold consent to call these contacts.');
  if (!c.consentBasis || String(c.consentBasis).trim().length < 10) problems.push('Describe how consent was obtained (at least a sentence).');
  return problems;
}

// ============================================================
async function uploadList(user, payload, ip) {
  const cert = payload.certification || {};
  const problems = validateCertification(cert);
  if (problems.length) {
    return { statusCode: 400, body: { error: 'Certification incomplete', problems } };
  }

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) return { statusCode: 400, body: { error: 'No rows supplied' } };
  if (rows.length > 20000) return { statusCode: 400, body: { error: 'Maximum 20,000 numbers per upload' } };

  const defaultCountry = payload.defaultCountry || 'US';

  // Normalise + de-dupe
  const seen = new Set();
  const good = [];
  const rejected = [];
  rows.forEach((r, idx) => {
    const e164 = toE164(r.phone, defaultCountry);
    if (!e164) { rejected.push({ row: idx + 1, phone: r.phone || '', reason: 'Not a valid phone number' }); return; }
    if (seen.has(e164)) { rejected.push({ row: idx + 1, phone: r.phone, reason: 'Duplicate in this file' }); return; }
    seen.add(e164);
    good.push({
      phone_e164: e164,
      first_name: (r.firstName || '').trim() || null,
      last_name: (r.lastName || '').trim() || null,
      email: (r.email || '').trim() || null,
      company: (r.company || '').trim() || null,
      title: (r.title || '').trim() || null,
      timezone: (r.timezone || '').trim() || null
    });
  });

  if (!good.length) return { statusCode: 400, body: { error: 'No valid phone numbers found', rejected } };

  // 1. create the list record carrying the certification
  const listRes = await sb('phone_lists', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: user.id,
      name: (payload.name || 'Phone list').slice(0, 120),
      source: (payload.source || '').slice(0, 80) || null,
      row_count: good.length,
      certified_by: String(cert.certifiedBy).slice(0, 120),
      certified_email: String(cert.certifiedEmail).toLowerCase().slice(0, 200),
      certification_ip: ip || null,
      attest_lawful_source: true,
      attest_consent_call: true,
      attest_consent_sms: cert.attestConsentSms === true,
      attest_consent_record: cert.attestConsentRecord === true,
      consent_basis: String(cert.consentBasis).slice(0, 2000),
      consent_obtained_at: cert.consentObtainedAt || null
    })
  });
  if (!listRes.ok) {
    const t = await listRes.text();
    return { statusCode: 500, body: { error: 'Could not save list', detail: t.slice(0, 200) } };
  }
  const list = (await listRes.json())[0];

  // 2. insert numbers, inheriting the list's consent flags
  const numbers = good.map(g => ({
    ...g,
    user_id: user.id,
    list_id: list.id,
    consent_call: true,
    consent_sms: cert.attestConsentSms === true,
    consent_record: cert.attestConsentRecord === true
  }));

  let inserted = 0, conflicts = 0;
  for (let i = 0; i < numbers.length; i += 500) {
    const batch = numbers.slice(i, i + 500);
    const r = await sb('phone_numbers', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(batch)
    });
    if (r.ok) inserted += batch.length; else conflicts += batch.length;
  }

  return {
    statusCode: 200,
    body: {
      success: true,
      listId: list.id,
      accepted: inserted,
      rejected: rejected.slice(0, 100),
      rejectedCount: rejected.length,
      smsAllowed: cert.attestConsentSms === true,
      recordingAllowed: cert.attestConsentRecord === true,
      note: cert.attestConsentSms === true ? null
        : 'SMS consent was not certified, so these numbers cannot be texted. Re-upload with SMS consent certified if you hold it.'
    }
  };
}

// ============================================================
async function downloadList(user, payload) {
  let q = `phone_numbers?user_id=eq.${user.id}&select=phone_e164,first_name,last_name,email,company,title,consent_call,consent_sms,consent_record,do_not_call,dnc_reason,created_at&order=created_at.desc&limit=20000`;
  if (payload.listId) q += `&list_id=eq.${payload.listId}`;
  if (payload.excludeDnc) q += `&do_not_call=eq.false`;

  const r = await sb(q);
  if (!r.ok) return { statusCode: 500, body: { error: 'Could not read numbers' } };
  const rows = await r.json();

  const head = ['Phone', 'First Name', 'Last Name', 'Email', 'Company', 'Title',
    'Consent: Call', 'Consent: SMS', 'Consent: Recording', 'Do Not Call', 'DNC Reason', 'Added'];
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const csv = [head.map(esc).join(',')].concat(
    rows.map(r2 => [r2.phone_e164, r2.first_name, r2.last_name, r2.email, r2.company, r2.title,
      r2.consent_call ? 'yes' : 'no', r2.consent_sms ? 'yes' : 'no', r2.consent_record ? 'yes' : 'no',
      r2.do_not_call ? 'YES' : 'no', r2.dnc_reason, r2.created_at].map(esc).join(','))
  ).join('\n');

  return { statusCode: 200, body: { success: true, count: rows.length, csv } };
}

// ============================================================
async function listSummary(user) {
  const r = await sb(`phone_lists?user_id=eq.${user.id}&select=id,name,source,row_count,certified_by,certified_at,attest_consent_sms,attest_consent_record,consent_basis&order=created_at.desc&limit=100`);
  if (!r.ok) return { statusCode: 500, body: { error: 'Could not read lists' } };
  return { statusCode: 200, body: { lists: await r.json() } };
}

// ============================================================
async function suppress(user, payload) {
  const e164 = toE164(payload.phone, payload.defaultCountry || 'US');
  if (!e164) return { statusCode: 400, body: { error: 'Invalid phone number' } };
  const r = await sb(`phone_numbers?user_id=eq.${user.id}&phone_e164=eq.${encodeURIComponent(e164)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      do_not_call: true,
      dnc_reason: (payload.reason || 'Opted out').slice(0, 200),
      opted_out_at: new Date().toISOString(),
      consent_call: false,
      consent_sms: false
    })
  });
  return { statusCode: r.ok ? 200 : 500, body: r.ok ? { success: true, phone: e164 } : { error: 'Could not suppress number' } };
}

// ============================================================
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HDR, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: HDR, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!SB || !SK)
    return { statusCode: 500, headers: HDR, body: JSON.stringify({ error: 'Server not configured' }) };

  const user = await getUser(event.headers.authorization || event.headers.Authorization);
  if (!user) return { statusCode: 401, headers: HDR, body: JSON.stringify({ error: 'Please sign in.' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;

  try {
    let out;
    if (body.action === 'upload') out = await uploadList(user, body.payload || {}, ip);
    else if (body.action === 'download') out = await downloadList(user, body.payload || {});
    else if (body.action === 'list') out = await listSummary(user);
    else if (body.action === 'suppress') out = await suppress(user, body.payload || {});
    else return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Unknown action' }) };
    return { statusCode: out.statusCode, headers: HDR, body: JSON.stringify(out.body) };
  } catch (e) {
    return { statusCode: 500, headers: HDR, body: JSON.stringify({ error: e.message || 'Request failed' }) };
  }
};

exports.toE164 = toE164;
exports.validateCertification = validateCertification;
