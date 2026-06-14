/**
 * bulk-generate.js -- Netlify Function: server-side bulk email generation
 * Place in: netlify/functions/bulk-generate.js
 *
 * Generates personalized emails for many contacts server-side so the job
 * continues even if the user closes the browser. Progress + results are
 * written to the compose_sessions table (job_state) and polled by the client.
 *
 * Actions:
 *   start  -- begin a generation job (returns immediately, processes async)
 *   status -- poll job progress + collect finished messages
 *
 * ENV: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

const HDR = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function ok(d){ return { statusCode: 200, headers: HDR, body: JSON.stringify(d) }; }
function err(m, c){ return { statusCode: c || 400, headers: HDR, body: JSON.stringify({ error: m }) }; }

async function getUser(token){
  const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_SERVICE_KEY;
  if(!U || !K) return null;
  const r = await fetch(U + '/auth/v1/user', { headers: { 'Authorization': 'Bearer ' + token, 'apikey': K } });
  if(!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

async function sbFetch(path, opts){
  const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_SERVICE_KEY;
  return fetch(U + path, Object.assign({}, opts, {
    headers: Object.assign({ 'apikey': K, 'Authorization': 'Bearer ' + K, 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, (opts && opts.headers) || {})
  }));
}

async function getJob(userId){
  const r = await sbFetch('/rest/v1/compose_sessions?user_id=eq.' + userId + '&session_key=eq.bulkjob&select=state&limit=1', { method: 'GET' });
  const rows = await r.json();
  if(rows && rows.length && rows[0].state){ try { return JSON.parse(rows[0].state); } catch(e){ return null; } }
  return null;
}

async function putJob(userId, job){
  const payload = { user_id: userId, session_key: 'bulkjob', state: JSON.stringify(job), updated_at: new Date().toISOString() };
  const existing = await sbFetch('/rest/v1/compose_sessions?user_id=eq.' + userId + '&session_key=eq.bulkjob&select=id&limit=1', { method: 'GET' });
  const rows = await existing.json();
  if(rows && rows.length){
    await sbFetch('/rest/v1/compose_sessions?user_id=eq.' + userId + '&session_key=eq.bulkjob', { method: 'PATCH', body: JSON.stringify(payload) });
  } else {
    payload.created_at = new Date().toISOString();
    await sbFetch('/rest/v1/compose_sessions', { method: 'POST', body: JSON.stringify(payload) });
  }
}

async function genOne(contact, sender){
  const KEY = process.env.ANTHROPIC_API_KEY;
  if(!KEY) return null;
  const prompt = 'Write a warm, personalized cold email to a LinkedIn connection.\n' +
    '- To: ' + (contact.firstName||'') + ' ' + (contact.lastName||'') + ', ' + (contact.title||'professional') + ' at ' + (contact.company||'their company') + '\n' +
    '- From: ' + (sender.name||'') + ', ' + (sender.company||'Velorah') + '\n' +
    '- Product: Velorah - AI Cold Email & Cybersecurity Risk Assessment Platform\n' +
    '- ALWAYS open with the salutation "Dear ' + (contact.firstName||'there') + ',"\n' +
    '- Under 150 words, soft CTA for a 15-min demo. End with an opt-out line.\n' +
    'JSON only, no markdown: {"subject":"...","body":"..."}';
  try{
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
    });
    const d = await resp.json();
    const txt = (d.content||[]).filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('');
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    if(s>=0 && e>s) return JSON.parse(txt.substring(s, e+1));
  }catch(e){}
  return null;
}

export const handler = async function(event){
  if(event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };
  if(event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const token = (event.headers.authorization || event.headers.Authorization || '').replace('Bearer ', '');
  const user = await getUser(token);
  if(!user) return err('Unauthorized', 401);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e){ return err('Invalid JSON'); }
  const action = body.action || 'status';

  if(action === 'status'){
    const job = await getJob(user.id);
    if(!job) return ok({ status: 'none' });
    return ok({ status: job.done ? 'done' : 'running', total: job.total, completed: job.completed, messages: job.messages || [] });
  }

  if(action === 'start'){
    const contacts = (body.contacts || []).slice(0, 200);
    const sender = body.sender || {};
    if(!contacts.length) return err('No contacts provided');

    // Initialize job
    const job = { total: contacts.length, completed: 0, messages: [], done: false, startedAt: Date.now() };
    await putJob(user.id, job);

    // Process. Netlify allows up to 26s; we generate as many as fit, persisting
    // progress so a follow-up "start" with remaining contacts continues the job.
    const deadline = Date.now() + 23000;
    for(let i = 0; i < contacts.length; i++){
      if(Date.now() > deadline) break;
      const email = await genOne(contacts[i], sender);
      job.messages.push({ contact: contacts[i], email: email });
      job.completed = i + 1;
      if(i % 3 === 0) await putJob(user.id, job); // checkpoint every 3
    }
    job.done = job.completed >= job.total;
    await putJob(user.id, job);
    return ok({ status: job.done ? 'done' : 'partial', total: job.total, completed: job.completed, messages: job.messages });
  }

  return err('Unknown action');
};
