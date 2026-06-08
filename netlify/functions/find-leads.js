/**
 * find-leads.js -- Koios Intel B2B contact search
 * Place in: netlify/functions/find-leads.js
 *
 * Actions:
 *   search     -- Apollo people/contacts search
 *   find-email -- Hunter.io email finder
 *   enrich     -- Lusha contact enrichment
 *   match      -- Apollo people/match by name+company
 */

// -- RATE LIMITER ---------------------------------------------
const _rl = new Map();
function _rate(id, max, win) {
  const n = Date.now();
  const r = _rl.get(id) || { c: 0, t: n + (win || 60000) };
  if (n > r.t) { r.c = 0; r.t = n + (win || 60000); }
  r.c++;
  _rl.set(id, r);
  return r.c <= (max || 30);
}

// -- CORS HEADERS ---------------------------------------------
const HDR = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type':                 'application/json',
  'X-Content-Type-Options':       'nosniff'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!_rate(ip, 30, 60000)) {
    return { statusCode: 429, headers: HDR, body: JSON.stringify({ error: 'Too many requests' }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: HDR, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const APOLLO_KEY = process.env.APOLLO_API_KEY || '';
  const HUNTER_KEY = process.env.HUNTER_API_KEY || '';
  const LUSHA_KEY  = process.env.LUSHA_API_KEY  || '';

  let action, searchParams, contact;
  try {
    const body = JSON.parse(event.body || '{}');
    action       = body.action       || 'search';
    searchParams = body.searchParams || {};
    contact      = body.contact      || {};
  } catch(e) {
    return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // -- ACTION: SEARCH (Apollo) -------------------------------
  if (action === 'search') {
    if (!APOLLO_KEY) {
      return { statusCode: 200, headers: HDR, body: JSON.stringify({
        contacts: [], total: 0,
        error: 'APOLLO_API_KEY not set in Netlify environment variables. Go to Site Settings > Environment Variables to add it.'
      })};
    }

    const titles = searchParams.titles || [];
    const limit  = Math.min(parseInt(searchParams.perPage) || 25, 100);

    // Build base Apollo payload -- api_key MUST be in body
    const basePayload = {
      api_key:  APOLLO_KEY,
      page:     parseInt(searchParams.page) || 1,
      per_page: limit
    };

    // Title filter
    if (titles.length > 0) {
      basePayload.person_titles = titles;
    } else {
      // No title filter -- add seniority to get quality results
      basePayload.person_seniorities = ['senior', 'vp', 'director', 'c_suite', 'founder', 'manager'];
    }

    // Location -- accept string or array
    const locs = searchParams.locations
      || (searchParams.location ? [searchParams.location] : []);
    if (locs.length > 0) basePayload.person_locations = locs;

    // Industry + keywords combined
    const kwParts = [searchParams.keywords, searchParams.industry].filter(Boolean);
    if (kwParts.length > 0) basePayload.q_keywords = kwParts.join(' ');

    // Company size
    const sizes = searchParams.companySizes || searchParams.employeeRanges || [];
    if (sizes.length > 0) basePayload.organization_num_employees_ranges = sizes;

    // Apollo endpoints to try in order
    const endpoints = [
      'https://api.apollo.io/v1/mixed_people/search',
      'https://api.apollo.io/v1/people/search',
      'https://api.apollo.io/api/v1/mixed_people/search',
      'https://api.apollo.io/api/v1/people/search',
      'https://api.apollo.io/v1/contacts/search',
    ];

    const errors = [];

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Cache-Control': 'no-cache',
            'x-api-key':     APOLLO_KEY
          },
          body: JSON.stringify(basePayload)
        });

        if (res.status === 404 || res.status === 405) continue;

        const text = await res.text();

        if (!res.ok) {
          let msg = url + ' -> ' + res.status;
          try { const d = JSON.parse(text); msg += ' ' + (d.message || d.error || ''); } catch(e) {}
          errors.push(msg.substring(0, 120));
          continue;
        }

        const data = JSON.parse(text);
        const people = data.people || data.contacts || data.results || [];

        if (!people.length) {
          const total = data.pagination ? data.pagination.total_entries : 0;
          if (total === 0) {
            return { statusCode: 200, headers: HDR, body: JSON.stringify({
              contacts: [], total: 0, page: 1, totalPages: 0,
              message: 'No contacts match these filters. Try removing some filters or broadening your search.'
            })};
          }
        }

        const contacts = people.map(function(p) {
          return {
            id:          p.id || Math.random().toString(36).substr(2, 9),
            firstName:   p.first_name || '',
            lastName:    p.last_name  || '',
            fullName:    p.name       || ((p.first_name || '') + ' ' + (p.last_name || '')).trim(),
            title:       p.title      || '',
            company:     p.organization ? (p.organization.name || '') : '',
            industry:    p.organization ? (p.organization.industry || '') : '',
            companySize: p.organization ? String(p.organization.estimated_num_employees || '') : '',
            location:    [p.city, p.state, p.country].filter(Boolean).join(', '),
            email:       p.email || '',
            emailStatus: p.email_status || '',
            linkedin:    p.linkedin_url || '',
            phone:       p.phone_numbers && p.phone_numbers[0] ? (p.phone_numbers[0].sanitized_number || '') : '',
            website:     p.organization ? (p.organization.website_url || '') : '',
            source:      'koios-intel'
          };
        });

        return { statusCode: 200, headers: HDR, body: JSON.stringify({
          contacts,
          total:      data.pagination ? (data.pagination.total_entries || contacts.length) : contacts.length,
          page:       data.pagination ? (data.pagination.page || 1) : 1,
          totalPages: data.pagination ? (data.pagination.total_pages || 1) : 1
        })};

      } catch(e) {
        errors.push(url.split('/').pop() + ': ' + e.message);
      }
    }

    // All endpoints failed
    return { statusCode: 200, headers: HDR, body: JSON.stringify({
      contacts: [], total: 0,
      error: 'Search failed. Errors: ' + errors.slice(0, 3).join(' | ') + '. Check: 1) APOLLO_API_KEY is valid in Netlify env vars 2) API key has people/search permission at developer.apollo.io/keys'
    })};
  }

  // -- ACTION: FIND EMAIL (Hunter.io) -----------------------
  if (action === 'find-email') {
    const firstName = contact.firstName || '';
    const lastName  = contact.lastName  || '';
    const company   = contact.company   || '';
    const domain    = contact.domain    || '';

    if (!firstName || !lastName) {
      return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'firstName and lastName required' }) };
    }

    // Try Apollo people/match first (most accurate for email finding)
    if (APOLLO_KEY) {
      try {
        const matchRes = await fetch('https://api.apollo.io/v1/people/match', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_KEY },
          body:    JSON.stringify({
            api_key:           APOLLO_KEY,
            first_name:        firstName,
            last_name:         lastName,
            organization_name: company,
            reveal_personal_emails: true
          })
        });
        if (matchRes.ok) {
          const matchData = await matchRes.json();
          const person = matchData.person || {};
          const email = person.email || (person.personal_emails && person.personal_emails[0]) || null;
          if (email) return { statusCode: 200, headers: HDR, body: JSON.stringify({ email, source: 'koios-verified' }) };
        }
      } catch(e) {}
    }

    // Try Hunter.io
    if (HUNTER_KEY) {
      try {
        let url = 'https://api.hunter.io/v2/email-finder'
          + '?first_name=' + encodeURIComponent(firstName)
          + '&last_name='  + encodeURIComponent(lastName)
          + '&api_key='    + HUNTER_KEY;
        if (domain)  url += '&domain='  + encodeURIComponent(domain);
        else if (company) url += '&company=' + encodeURIComponent(company);

        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const email = data.data && data.data.email;
          if (email) return { statusCode: 200, headers: HDR, body: JSON.stringify({ email, source: 'koios-enriched' }) };
        }
      } catch(e) {}
    }

    // Try Lusha
    if (LUSHA_KEY) {
      try {
        const lushaRes = await fetch('https://api.lusha.com/person?firstName=' + encodeURIComponent(firstName) + '&lastName=' + encodeURIComponent(lastName) + '&company=' + encodeURIComponent(company), {
          headers: { 'api_key': LUSHA_KEY }
        });
        if (lushaRes.ok) {
          const lushaData = await lushaRes.json();
          const email = lushaData.emailAddresses && lushaData.emailAddresses[0] && lushaData.emailAddresses[0].value;
          if (email) return { statusCode: 200, headers: HDR, body: JSON.stringify({ email, source: 'koios-enriched' }) };
        }
      } catch(e) {}
    }

    return { statusCode: 200, headers: HDR, body: JSON.stringify({ email: null, message: 'No email found for this contact' }) };
  }

  // -- ACTION: IDENTITY MATCH (Apollo) ----------------------
  if (action === 'match') {
    if (!APOLLO_KEY) {
      return { statusCode: 200, headers: HDR, body: JSON.stringify({ email: null, error: 'APOLLO_API_KEY not configured' }) };
    }
    try {
      const payload = {
        api_key:                APOLLO_KEY,
        first_name:             contact.firstName || '',
        last_name:              contact.lastName  || '',
        reveal_personal_emails: true,
        reveal_phone_number:    false
      };
      if (contact.company)     payload.organization_name = contact.company;
      if (contact.linkedinUrl) payload.linkedin_url      = contact.linkedinUrl;

      const res = await fetch('https://api.apollo.io/v1/people/match', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': APOLLO_KEY },
        body:    JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json().catch(function() { return {}; });
        return { statusCode: 200, headers: HDR, body: JSON.stringify({ email: null, error: 'Match failed: ' + (err.message || res.status) }) };
      }

      const data   = await res.json();
      const person = data.person || {};
      const email  = person.email || (person.personal_emails && person.personal_emails[0]) || null;

      return { statusCode: 200, headers: HDR, body: JSON.stringify({
        email,
        title:   person.title || null,
        company: person.organization ? person.organization.name : null,
        source:  'koios-intel'
      })};
    } catch(e) {
      return { statusCode: 200, headers: HDR, body: JSON.stringify({ email: null, error: e.message }) };
    }
  }

  return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
};
