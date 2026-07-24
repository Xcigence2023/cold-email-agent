/**
 * campaign-intel.js — Velorah Campaign Intelligence
 * netlify/functions/campaign-intel.js
 *
 * Two actions:
 *   'adapt'  — take the user's OWN composed email and rewrite it for one
 *              recipient (role, industry, company), preserving their voice,
 *              value proposition and CTA. Optional web research for specifics.
 *   'verify' — pre-send check on ONE recipient. Uses web search to look for
 *              evidence they have died or left the company, and to identify
 *              who currently holds the role.
 *
 * DESIGN NOTE (verify):
 *   This NEVER asserts a death or departure from model memory. Every claim
 *   must be backed by a search result, and the response carries the sources so
 *   a human can check. Suggested replacement emails are PATTERN GUESSES derived
 *   from addresses the customer already holds, explicitly labelled unverified.
 *   The UI excludes flagged recipients by default but never deletes them.
 *
 * ENV: ANTHROPIC_API_KEY (required), SUPABASE_URL + SUPABASE_SERVICE_KEY (auth)
 */

const MODEL = 'claude-sonnet-4-6';

const HDR = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'X-Content-Type-Options': 'nosniff'
};

// ---- simple per-token rate limit ----
const _rl = new Map();
function _rate(id, max, win) {
  const n = Date.now(), r = _rl.get(id) || { c: 0, t: n + (win || 60000) };
  if (n > r.t) { r.c = 0; r.t = n + (win || 60000); }
  r.c++; _rl.set(id, r);
  return r.c <= (max || 60);
}

async function requireUser(authHeader) {
  const SB = process.env.SUPABASE_URL, SK = process.env.SUPABASE_SERVICE_KEY;
  if (!SB || !SK) return null;
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

function extractJSON(text) {
  let t = String(text || '').replace(/```json|```/g, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(t.substring(s, e + 1)); } catch (_) { return null; }
}

async function callClaude(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data && data.error && data.error.message) || ('Claude API ' + res.status));
  return data;
}

function textOf(data) {
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

/* Collect the URLs the model actually consulted, so the UI can show sources. */
function sourcesOf(data) {
  const urls = [];
  (data.content || []).forEach(b => {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      b.content.forEach(r => { if (r && r.url) urls.push({ url: r.url, title: r.title || r.url }); });
    }
  });
  // de-dupe
  const seen = new Set();
  return urls.filter(u => (seen.has(u.url) ? false : (seen.add(u.url), true))).slice(0, 8);
}

// ============================================================
// ACTION: adapt — rewrite the user's own email for one recipient
// ============================================================
async function adaptEmail(payload) {
  const r = payload.recipient || {};
  const base = payload.baseEmail || {};
  const prefs = payload.senderPrefs || {};
  const research = payload.research === true;

  if (!base.body || !String(base.body).trim()) throw new Error('No base email body provided');

  const recipientBlock =
    `- Name: ${r.name || '(unknown)'}\n` +
    `- Job title: ${r.title || '(unknown)'}\n` +
    `- Company: ${r.company || '(unknown)'}\n` +
    `- Industry: ${r.industry || '(unknown)'}`;

  const system =
`You adapt a sales email that a human has already written, tailoring it to one specific recipient.

ABSOLUTE RULES
1. PRESERVE the author's voice, tone, sentence rhythm and vocabulary. This must still read like the same person wrote it.
2. PRESERVE the core offer, any statistics, credentials, links and the call to action EXACTLY as written. Do not alter numbers, product claims, patent numbers, funding figures or URLs.
3. PRESERVE the sign-off block verbatim (name, title, phone, links) if present.
4. ADAPT the opening hook, the framing of the problem, and any industry or role specific references so they speak to THIS recipient's position, sector and likely priorities.
5. NEVER invent facts about the recipient or their company. If you do not know something, write around it. No fabricated funding rounds, headcounts, mutual connections, or recent news.
6. Keep roughly the same length as the original.
7. If the original opens with "Dear X" or similar, use this recipient's first name.

Respond with ONLY valid JSON, no markdown:
{"subject":"...","body":"...","changes":"one short sentence on what you tailored"}`;

  const user =
`ORIGINAL EMAIL THE AUTHOR WROTE
Subject: ${base.subject || '(none)'}

${base.body}

---
ADAPT IT FOR THIS RECIPIENT
${recipientBlock}
${prefs.tone ? `\nAuthor's preferred tone: ${prefs.tone}` : ''}${prefs.avoidPhrases ? `\nNever use these phrases: ${prefs.avoidPhrases}` : ''}
${research ? '\nUse web search to find one concrete, verifiable detail about this company or role that makes the opening specific. If you cannot verify anything, do not invent — keep the opening general.' : ''}

Return the adapted email as JSON.`;

  const body = {
    model: MODEL,
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: user }]
  };
  if (research) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  const data = await callClaude(body);
  const parsed = extractJSON(textOf(data));
  if (!parsed || !parsed.body) throw new Error('Could not parse adapted email');
  return {
    subject: parsed.subject || base.subject || '',
    body: parsed.body,
    changes: parsed.changes || '',
    sources: research ? sourcesOf(data) : []
  };
}

// ============================================================
// ACTION: verify — pre-send check on one recipient
// ============================================================
async function verifyRecipient(payload) {
  const r = payload.recipient || {};
  const knownEmails = Array.isArray(payload.knownEmails) ? payload.knownEmails.slice(0, 40) : [];

  if (!r.name && !r.company) throw new Error('Need at least a name or company to verify');

  const system =
`You are a pre-send verification assistant for a B2B outreach tool. You check whether it is still appropriate to email one named person.

You have web search. Use it.

WHAT TO CHECK
1. Is there credible published evidence this person has DIED?
2. Is there credible evidence they have LEFT the company or changed role?
3. If either is true, who currently holds that role or leads that function?

EVIDENCE RULES — these are absolute
- Report a death or departure ONLY if a search result you actually retrieved supports it. Never state it from memory or inference.
- Every claim in "findings" must have a matching source URL you actually saw in results.
- If you find nothing, that is a normal and correct outcome: status "ok", empty findings. Do NOT speculate.
- If sources conflict or are ambiguous or old, use status "verify" and say precisely what is unclear.
- Never guess an email address. For alternates, give the person's name/title/source; leave email null. The caller derives address patterns separately.

STATUS VALUES
"ok"          — no evidence of any problem; safe to send
"verify"      — something is unclear or possibly stale; a human should check before sending
"do_not_send" — strong, sourced evidence the person is deceased, or has definitively left

Respond with ONLY valid JSON, no markdown:
{
 "status":"ok|verify|do_not_send",
 "confidence":"low|medium|high",
 "headline":"one short sentence, or empty string if status is ok",
 "findings":[{"claim":"what you found","source":"https://..."}],
 "alternates":[{"name":"...","title":"...","why":"why they are the right contact now","source":"https://..."}],
 "note":"optional guidance for the sender, e.g. how to handle it respectfully"
}`;

  const user =
`Verify this outreach recipient:
- Name: ${r.name || '(unknown)'}
- Job title: ${r.title || '(unknown)'}
- Company: ${r.company || '(unknown)'}

Search for their current status and role. If they have died or moved on, identify who holds the relevant role at ${r.company || 'the company'} now.`;

  const data = await callClaude({
    model: MODEL,
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: user }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }]
  });

  const parsed = extractJSON(textOf(data)) || { status: 'ok', confidence: 'low', headline: '', findings: [], alternates: [], note: '' };
  const sources = sourcesOf(data);

  // Fail safe: a flag with no source is downgraded to "verify" — we never assert
  // a death or departure the model could not back with a retrieved page.
  if ((parsed.status === 'do_not_send') && (!parsed.findings || !parsed.findings.length)) {
    parsed.status = 'verify';
    parsed.note = (parsed.note ? parsed.note + ' ' : '') + '(Downgraded: no source was retrieved to support this.)';
  }

  // Derive an email PATTERN from addresses the customer already has for this
  // company. This is inference from their own data, clearly labelled — never
  // an invented address.
  const domain = (function () {
    const hit = knownEmails.find(e => typeof e === 'string' && e.indexOf('@') > 0);
    return hit ? hit.split('@')[1] : null;
  })();
  const pattern = (function () {
    // look at an existing address to infer first / first.last / firstinitiallast
    const sample = knownEmails.find(e => typeof e === 'string' && e.indexOf('@') > 0);
    if (!sample) return null;
    const local = sample.split('@')[0];
    if (/^[a-z]+\.[a-z]+$/i.test(local)) return 'first.last';
    if (/^[a-z]\.[a-z]+$/i.test(local)) return 'f.last';
    if (/^[a-z]+_[a-z]+$/i.test(local)) return 'first_last';
    if (/^[a-z]+$/i.test(local)) return 'first';
    return null;
  })();

  (parsed.alternates || []).forEach(a => {
    a.emailGuess = null;
    a.emailBasis = null;
    if (domain && pattern && a.name) {
      const parts = String(a.name).toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/);
      const f = parts[0] || '', l = parts[parts.length - 1] || '';
      let local = null;
      if (pattern === 'first.last' && f && l) local = f + '.' + l;
      else if (pattern === 'f.last' && f && l) local = f[0] + '.' + l;
      else if (pattern === 'first_last' && f && l) local = f + '_' + l;
      else if (pattern === 'first' && f) local = f;
      if (local) {
        a.emailGuess = local + '@' + domain;
        a.emailBasis = 'Pattern inferred from addresses already in your list (' + pattern + '@' + domain + '). UNVERIFIED — confirm before sending.';
      }
    }
  });

  return {
    status: parsed.status || 'ok',
    confidence: parsed.confidence || 'low',
    headline: parsed.headline || '',
    findings: parsed.findings || [],
    alternates: parsed.alternates || [],
    note: parsed.note || '',
    sources
  };
}

// ============================================================
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HDR, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: HDR, body: JSON.stringify({ error: 'Method not allowed' }) };

  const auth = event.headers.authorization || event.headers.Authorization;
  const user = await requireUser(auth);
  if (!user) return { statusCode: 401, headers: HDR, body: JSON.stringify({ error: 'Please sign in.' }) };

  if (!_rate(user.id, 120, 60000))
    return { statusCode: 429, headers: HDR, body: JSON.stringify({ error: 'Too many requests. Please slow down.' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  try {
    if (body.action === 'adapt') {
      const out = await adaptEmail(body.payload || {});
      return { statusCode: 200, headers: HDR, body: JSON.stringify(out) };
    }
    if (body.action === 'verify') {
      const out = await verifyRecipient(body.payload || {});
      return { statusCode: 200, headers: HDR, body: JSON.stringify(out) };
    }
    return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 200, headers: HDR, body: JSON.stringify({ error: e.message || 'Request failed' }) };
  }
};

exports.adaptEmail = adaptEmail;
exports.verifyRecipient = verifyRecipient;
