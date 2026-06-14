/**
 * crm.js -- Netlify Function: CRM Integration Hub
 * Place in: netlify/functions/crm.js
 *
 * Actions:
 *   import   -- fetch contacts from a connected CRM (HubSpot | Salesforce | Pipedrive | Zoho | GHL | ActiveCampaign)
 *   push     -- write email activity/note back to the CRM after a campaign send
 *   test     -- verify a stored API key connects successfully
 *   save_draft -- persist uploaded CSV leads to Supabase so they survive navigation
 *   load_draft -- retrieve saved draft leads for resume
 *   list_drafts -- list all draft campaigns for the user
 *   delete_draft -- remove a draft
 *
 * ENV VARS (all optional -- only needed per CRM):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY  (for draft persistence)
 */

const HDR = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type':                 'application/json',
};

const _rl = new Map();
function _rate(id, max, win) {
  const n = Date.now(), r = _rl.get(id) || { c: 0, t: n + (win || 60000) };
  if (n > r.t) { r.c = 0; r.t = n + (win || 60000); }
  r.c++; _rl.set(id, r);
  return r.c <= (max || 30);
}

function ok(data)  { return { statusCode: 200, headers: HDR, body: JSON.stringify(data) }; }
function err(msg, code) { return { statusCode: code || 400, headers: HDR, body: JSON.stringify({ error: msg }) }; }

// -- SUPABASE AUTH ---------------------------------------------
async function getUser(token) {
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_URL || !SB_KEY) return null;
  const r = await fetch(SB_URL + '/auth/v1/user', {
    headers: { 'Authorization': 'Bearer ' + token, 'apikey': SB_KEY }
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

async function sbFetch(path, opts) {
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  return fetch(SB_URL + path, Object.assign({}, opts, {
    headers: Object.assign({ 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' }, opts.headers || {})
  }));
}

// -- CRM IMPORTERS ---------------------------------------------

// HubSpot: contacts -> Velorah lead format
async function importHubSpot(apiKey, limit) {
  const url = 'https://api.hubapi.com/crm/v3/objects/contacts?limit=' + (limit || 50) +
    '&properties=firstname,lastname,email,company,jobtitle,industry,numberofemployees,annualrevenue,hs_lead_status';
  const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + apiKey } });
  if (!r.ok) {
    const e = await r.text();
    throw new Error('HubSpot ' + r.status + ': ' + e.substring(0, 120));
  }
  const d = await r.json();
  return (d.results || []).map(function(c) {
    const p = c.properties || {};
    return {
      crm_id:        c.id,
      crm_source:    'hubspot',
      firstName:     p.firstname || '',
      lastName:      p.lastname  || '',
      fullName:      ((p.firstname || '') + ' ' + (p.lastname || '')).trim(),
      email:         p.email || '',
      company:       p.company || '',
      title:         p.jobtitle || '',
      industry:      p.industry || '',
      companySize:   p.numberofemployees || '',
      revenue:       p.annualrevenue || '',
      status:        p.hs_lead_status || '',
    };
  }).filter(function(c) { return c.email; });
}

// Salesforce: query contacts via REST API
async function importSalesforce(accessToken, instanceUrl, limit) {
  const soql = encodeURIComponent(
    'SELECT Id,FirstName,LastName,Email,Account.Name,Title,Department,Account.Industry,Account.NumberOfEmployees,Account.AnnualRevenue ' +
    'FROM Contact WHERE Email != null LIMIT ' + (limit || 50)
  );
  const r = await fetch(instanceUrl + '/services/data/v59.0/query/?q=' + soql, {
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
  });
  if (!r.ok) throw new Error('Salesforce ' + r.status);
  const d = await r.json();
  return (d.records || []).map(function(c) {
    return {
      crm_id:      c.Id,
      crm_source:  'salesforce',
      firstName:   c.FirstName || '',
      lastName:    c.LastName  || '',
      fullName:    ((c.FirstName || '') + ' ' + (c.LastName || '')).trim(),
      email:       c.Email,
      company:     (c.Account && c.Account.Name) || '',
      title:       c.Title || '',
      industry:    (c.Account && c.Account.Industry) || '',
      companySize: (c.Account && c.Account.NumberOfEmployees) || '',
      revenue:     (c.Account && c.Account.AnnualRevenue) || '',
    };
  });
}

// Pipedrive: persons endpoint
async function importPipedrive(apiKey, limit) {
  const r = await fetch('https://api.pipedrive.com/v1/persons?api_token=' + apiKey + '&limit=' + (limit || 50) + '&status=open&sort=update_time DESC');
  if (!r.ok) throw new Error('Pipedrive ' + r.status);
  const d = await r.json();
  return ((d.data) || []).map(function(p) {
    const email = (p.email && p.email[0] && p.email[0].value) || '';
    const org = p.org_id && p.org_id.name ? p.org_id.name : '';
    return {
      crm_id:     String(p.id),
      crm_source: 'pipedrive',
      firstName:  p.first_name || '',
      lastName:   p.last_name  || '',
      fullName:   p.name || '',
      email:      email,
      company:    org,
      title:      p.job_title || '',
      industry:   '',
      companySize:'',
      revenue:    '',
    };
  }).filter(function(c) { return c.email; });
}

// Zoho CRM: contacts module
async function importZoho(accessToken, dataCentre, limit) {
  const base = dataCentre && dataCentre !== 'com' ? 'https://www.zohoapis.' + dataCentre : 'https://www.zohoapis.com';
  const r = await fetch(base + '/crm/v3/Contacts?per_page=' + (limit || 50) + '&fields=First_Name,Last_Name,Email,Account_Name,Title,Industry,No_of_Employees', {
    headers: { 'Authorization': 'Zoho-oauthtoken ' + accessToken }
  });
  if (!r.ok) throw new Error('Zoho ' + r.status);
  const d = await r.json();
  return ((d.data) || []).map(function(c) {
    return {
      crm_id:     c.id,
      crm_source: 'zoho',
      firstName:  c.First_Name || '',
      lastName:   c.Last_Name  || '',
      fullName:   ((c.First_Name || '') + ' ' + (c.Last_Name || '')).trim(),
      email:      c.Email || '',
      company:    c.Account_Name || '',
      title:      c.Title || '',
      industry:   c.Industry || '',
      companySize:c.No_of_Employees || '',
      revenue:    '',
    };
  }).filter(function(c) { return c.email; });
}

// GoHighLevel (GHL)
async function importGHL(apiKey, limit) {
  const r = await fetch('https://rest.gohighlevel.com/v1/contacts/?limit=' + (limit || 50), {
    headers: { 'Authorization': 'Bearer ' + apiKey }
  });
  if (!r.ok) throw new Error('GoHighLevel ' + r.status);
  const d = await r.json();
  return ((d.contacts) || []).map(function(c) {
    return {
      crm_id:     c.id,
      crm_source: 'ghl',
      firstName:  c.firstName || '',
      lastName:   c.lastName  || '',
      fullName:   ((c.firstName || '') + ' ' + (c.lastName || '')).trim(),
      email:      (c.email) || '',
      company:    c.companyName || '',
      title:      c.title || '',
      industry:   '',
      companySize:'',
      revenue:    '',
    };
  }).filter(function(c) { return c.email; });
}

// ActiveCampaign
async function importActiveCampaign(apiKey, accountName, limit) {
  const base = 'https://' + accountName + '.api-us1.com/api/3';
  const r = await fetch(base + '/contacts?limit=' + (limit || 50), {
    headers: { 'Api-Token': apiKey }
  });
  if (!r.ok) throw new Error('ActiveCampaign ' + r.status);
  const d = await r.json();
  return ((d.contacts) || []).map(function(c) {
    return {
      crm_id:     c.id,
      crm_source: 'activecampaign',
      firstName:  c.firstName || '',
      lastName:   c.lastName  || '',
      fullName:   ((c.firstName || '') + ' ' + (c.lastName || '')).trim(),
      email:      c.email || '',
      company:    c.orgname || '',
      title:      c.jobtitle || '',
      industry:   '',
      companySize:'',
      revenue:    '',
    };
  }).filter(function(c) { return c.email; });
}

// Notion (database with contact records)
async function importNotion(apiKey, databaseId, limit) {
  const r = await fetch('https://api.notion.com/v1/databases/' + databaseId + '/query', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_size: limit || 50 })
  });
  if (!r.ok) throw new Error('Notion ' + r.status);
  const d = await r.json();
  return ((d.results) || []).map(function(page) {
    const p = page.properties || {};
    function getProp(name, type) {
      const prop = p[name];
      if (!prop) return '';
      if (type === 'email') return prop.email || '';
      if (type === 'rich_text') return (prop.rich_text && prop.rich_text[0] && prop.rich_text[0].plain_text) || '';
      if (type === 'title') return (prop.title && prop.title[0] && prop.title[0].plain_text) || '';
      if (type === 'select') return (prop.select && prop.select.name) || '';
      return '';
    }
    return {
      crm_id:     page.id,
      crm_source: 'notion',
      fullName:   getProp('Name', 'title') || getProp('Full Name', 'title'),
      email:      getProp('Email', 'email'),
      company:    getProp('Company', 'rich_text') || getProp('Organization', 'rich_text'),
      title:      getProp('Title', 'rich_text') || getProp('Job Title', 'rich_text'),
      industry:   getProp('Industry', 'select') || getProp('Industry', 'rich_text'),
      companySize:'',
      revenue:    '',
    };
  }).filter(function(c) { return c.email; });
}

// -- CRM PUSH (write email activity back to CRM) ---------------

async function pushHubSpot(apiKey, leads) {
  const results = [];
  for (var i = 0; i < leads.length; i++) {
    const lead = leads[i];
    if (!lead.crm_id || !lead.email) continue;
    try {
      // Create email engagement note on the contact
      await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          properties: {
            hs_note_body: 'Velorah Campaign: ' + (lead.subject || 'Email sent') + '\n\nSent: ' + new Date().toISOString() + '\nStatus: ' + (lead.sendStatus || 'sent'),
            hs_timestamp: String(Date.now())
          },
          associations: [{ to: { id: lead.crm_id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }]
        })
      });
      results.push({ email: lead.email, status: 'pushed' });
    } catch(e) { results.push({ email: lead.email, status: 'error', error: e.message }); }
  }
  return results;
}

// -- DRAFT PERSISTENCE -----------------------------------------

async function saveSession(userId, sessionKey, state) {
  const payload = {
    user_id:    userId,
    session_key: sessionKey,
    state:      JSON.stringify(state || {}),
    updated_at: new Date().toISOString(),
  };
  // Upsert by (user_id, session_key)
  const existing = await sbFetch(
    '/rest/v1/compose_sessions?user_id=eq.' + userId + '&session_key=eq.' + encodeURIComponent(sessionKey) + '&select=id&limit=1',
    { method: 'GET' }
  );
  const rows = await existing.json();
  if (rows && rows.length > 0) {
    await sbFetch('/rest/v1/compose_sessions?user_id=eq.' + userId + '&session_key=eq.' + encodeURIComponent(sessionKey), {
      method: 'PATCH', body: JSON.stringify(payload)
    });
    return { saved: true, updated: true };
  } else {
    payload.created_at = new Date().toISOString();
    await sbFetch('/rest/v1/compose_sessions', { method: 'POST', body: JSON.stringify(payload) });
    return { saved: true, created: true };
  }
}

async function loadSession(userId, sessionKey) {
  const r = await sbFetch(
    '/rest/v1/compose_sessions?user_id=eq.' + userId + '&session_key=eq.' + encodeURIComponent(sessionKey) + '&select=state&limit=1',
    { method: 'GET' }
  );
  const rows = await r.json();
  if (rows && rows.length > 0 && rows[0].state) {
    try { return JSON.parse(rows[0].state); } catch(e) { return null; }
  }
  return null;
}

async function clearSession(userId, sessionKey) {
  await sbFetch('/rest/v1/compose_sessions?user_id=eq.' + userId + '&session_key=eq.' + encodeURIComponent(sessionKey), {
    method: 'DELETE'
  });
  return true;
}

async function saveDraft(userId, body) {
  const payload = {
    user_id:      userId,
    name:         (body.name || 'Draft Campaign').substring(0, 100),
    leads:        JSON.stringify(body.leads || []),
    headers:      JSON.stringify(body.headers || []),
    col_map:      JSON.stringify(body.colMap || {}),
    sender_prefs: JSON.stringify(body.senderPrefs || {}),
    lead_count:   (body.leads || []).length,
    status:       'draft',
    source:       body.source || 'csv',
    crm_source:   body.crmSource || null,
    updated_at:   new Date().toISOString(),
  };

  const existing = await sbFetch(
    '/rest/v1/campaigns?user_id=eq.' + userId + '&status=eq.draft&select=id&limit=1',
    { method: 'GET' }
  );
  const rows = await existing.json();

  if (rows && rows.length > 0 && body.draft_id) {
    // Update existing draft
    const r = await sbFetch('/rest/v1/campaigns?id=eq.' + body.draft_id + '&user_id=eq.' + userId, {
      method: 'PATCH', body: JSON.stringify(payload)
    });
    const updated = await r.json();
    return { draft_id: body.draft_id, lead_count: payload.lead_count };
  } else {
    // Insert new draft
    payload.created_at = new Date().toISOString();
    const r = await sbFetch('/rest/v1/campaigns', {
      method: 'POST', body: JSON.stringify(payload)
    });
    const inserted = await r.json();
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    return { draft_id: row && row.id, lead_count: payload.lead_count };
  }
}

async function loadDrafts(userId) {
  const r = await sbFetch(
    '/rest/v1/campaigns?user_id=eq.' + userId + '&status=eq.draft&order=updated_at.desc&select=id,name,lead_count,source,crm_source,updated_at,leads,headers,col_map,sender_prefs',
    { method: 'GET' }
  );
  return await r.json();
}

async function deleteDraft(userId, draftId) {
  await sbFetch('/rest/v1/campaigns?id=eq.' + draftId + '&user_id=eq.' + userId + '&status=eq.draft', {
    method: 'DELETE'
  });
  return { deleted: true };
}

// -- MAIN HANDLER ----------------------------------------------
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!_rate(ip, 30, 60000)) return err('Too many requests', 429);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch(e) { return err('Invalid JSON'); }

  const action = body.action;
  if (!action) return err('action required');

  // Auth for all actions
  const token = (event.headers['authorization'] || '').replace('Bearer ', '');
  let user = null;
  if (token) user = await getUser(token).catch(function() { return null; });

  // Draft actions require auth
  if (['save_draft','load_draft','list_drafts','delete_draft','push'].includes(action) && !user) {
    return err('Unauthorized', 401);
  }

  // -- SAVE DRAFT -----------------------------------------------
  if (action === 'save_draft') {
    if (!body.leads || !body.leads.length) return err('leads required');
    const result = await saveDraft(user.id, body);
    return ok(result);
  }

  // -- SESSION STATE (compose auto-save / crash recovery) --------
  if (action === 'save_session') {
    const result = await saveSession(user.id, body.sessionKey || 'linkedin', body.state || {});
    return ok(result);
  }
  if (action === 'load_session') {
    const state = await loadSession(user.id, body.sessionKey || 'linkedin');
    return ok({ state: state });
  }
  if (action === 'clear_session') {
    await clearSession(user.id, body.sessionKey || 'linkedin');
    return ok({ cleared: true });
  }

  // -- LIST / LOAD DRAFTS ----------------------------------------
  if (action === 'list_drafts' || action === 'load_draft') {
    const drafts = await loadDrafts(user.id);
    if (action === 'load_draft') {
      const target = (drafts || []).find(function(d) { return d.id === body.draft_id; });
      if (!target) return err('Draft not found', 404);
      return ok({
        draft:       target,
        leads:       JSON.parse(target.leads || '[]'),
        headers:     JSON.parse(target.headers || '[]'),
        colMap:      JSON.parse(target.col_map || '{}'),
        senderPrefs: JSON.parse(target.sender_prefs || '{}'),
      });
    }
    return ok({ drafts: (drafts || []).map(function(d) {
      return { id: d.id, name: d.name, lead_count: d.lead_count, source: d.source, crm_source: d.crm_source, updated_at: d.updated_at };
    })});
  }

  // -- DELETE DRAFT ---------------------------------------------
  if (action === 'delete_draft') {
    if (!body.draft_id) return err('draft_id required');
    return ok(await deleteDraft(user.id, body.draft_id));
  }

  // -- CRM IMPORT -----------------------------------------------
  if (action === 'import') {
    const crm    = String(body.crm || '').toLowerCase();
    const apiKey = String(body.api_key || body.apiKey || '');
    const limit  = Math.min(parseInt(body.limit || 50), 200);

    if (!crm)    return err('crm required');
    if (!apiKey) return err('api_key required');

    let contacts = [];
    try {
      if (crm === 'hubspot')       contacts = await importHubSpot(apiKey, limit);
      else if (crm === 'salesforce') contacts = await importSalesforce(apiKey, body.instance_url, limit);
      else if (crm === 'pipedrive')  contacts = await importPipedrive(apiKey, limit);
      else if (crm === 'zoho')       contacts = await importZoho(apiKey, body.data_centre || 'com', limit);
      else if (crm === 'ghl')        contacts = await importGHL(apiKey, limit);
      else if (crm === 'activecampaign') contacts = await importActiveCampaign(apiKey, body.account_name, limit);
      else if (crm === 'notion')     contacts = await importNotion(apiKey, body.database_id, limit);
      else return err('Unknown CRM: ' + crm);
    } catch(e) {
      return err('CRM import failed: ' + e.message, 502);
    }

    // Auto-save as draft if user is authenticated
    let draft_id = null;
    if (user && contacts.length > 0) {
      try {
        const saved = await saveDraft(user.id, {
          name:      (body.campaign_name || (crm.charAt(0).toUpperCase() + crm.slice(1)) + ' Import'),
          leads:     contacts,
          source:    'crm',
          crmSource: crm,
          draft_id:  body.draft_id,
        });
        draft_id = saved.draft_id;
      } catch(e) {}
    }

    return ok({ contacts, count: contacts.length, crm, draft_id });
  }

  // -- CRM TEST CONNECTION ---------------------------------------
  if (action === 'test') {
    const crm    = String(body.crm || '').toLowerCase();
    const apiKey = String(body.api_key || body.apiKey || '');
    if (!crm || !apiKey) return err('crm and api_key required');
    try {
      let contacts = [];
      if (crm === 'hubspot')        contacts = await importHubSpot(apiKey, 1);
      else if (crm === 'salesforce') contacts = await importSalesforce(apiKey, body.instance_url, 1);
      else if (crm === 'pipedrive')  contacts = await importPipedrive(apiKey, 1);
      else if (crm === 'zoho')       contacts = await importZoho(apiKey, body.data_centre || 'com', 1);
      else if (crm === 'ghl')        contacts = await importGHL(apiKey, 1);
      else if (crm === 'activecampaign') contacts = await importActiveCampaign(apiKey, body.account_name, 1);
      else if (crm === 'notion')     contacts = await importNotion(apiKey, body.database_id, 1);
      else return err('Unknown CRM: ' + crm);
      return ok({ success: true, crm, sample_count: contacts.length });
    } catch(e) {
      return ok({ success: false, crm, error: e.message });
    }
  }

  // -- CRM PUSH -------------------------------------------------
  if (action === 'push') {
    const crm    = String(body.crm || '').toLowerCase();
    const apiKey = String(body.api_key || body.apiKey || '');
    const leads  = Array.isArray(body.leads) ? body.leads : [];
    if (!crm || !apiKey) return err('crm and api_key required');
    try {
      let results = [];
      if (crm === 'hubspot') results = await pushHubSpot(apiKey, leads);
      else results = leads.map(function(l) { return { email: l.email, status: 'skipped', reason: 'push not yet supported for ' + crm }; });
      return ok({ results, count: results.length });
    } catch(e) {
      return err('Push failed: ' + e.message, 502);
    }
  }

  return err('Unknown action: ' + action);
};
