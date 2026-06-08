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
  if(!_rate(_rlip, 30, 60000)) return {statusCode:429, headers, body:JSON.stringify({error:'Too many requests. Please slow down.'})};
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const APOLLO_KEY = process.env.APOLLO_API_KEY;
  const HUNTER_KEY = process.env.HUNTER_API_KEY;
  const LUSHA_KEY  = process.env.LUSHA_API_KEY;

  let action, searchParams, contact;
  try {
    const body = JSON.parse(event.body || '{}');
    action       = body.action || 'search';
    searchParams = body.searchParams || {};
    contact      = body.contact || {};
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // ── APOLLO PEOPLE SEARCH ──────────────────────────────────
  if (action === 'search') {
    if (!APOLLO_KEY) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Intelligence database not configured in Netlify environment variables.' }) };

    const titles = searchParams.titles || [
      'CISO','Chief Information Security Officer','CTO','Chief Technology Officer',
      'CEO','Chief Executive Officer','VP of Security','VP of IT',
      'Vice President of Security','Vice President of IT',
      'Chief Security Officer','Chief Cybersecurity Officer',
      'Security Manager','Security Lead','Security Director',
      'Head of Information Security','Director of Security',
      'Director of Information Security','Director of IT',
      'Head of Cybersecurity','Cybersecurity Manager',
      'Information Security Manager','IT Security Manager',
      'Security Architect','Chief Information Officer','CIO'
    ];

    const basePayload = {
      page:     searchParams.page    || 1,
      per_page: Math.min(searchParams.perPage || 25, 100),
      person_titles: (titles && titles.length > 0) ? titles : undefined
    };

    // Accept location (string) or locations (array)
    const locs = searchParams.locations || (searchParams.location ? [searchParams.location] : []);
    if (locs.length > 0) basePayload.person_locations = locs;
    // Combine keywords and industry into search query
    const kwParts = [searchParams.keywords, searchParams.industry].filter(Boolean);
    if (kwParts.length > 0) basePayload.q_keywords = kwParts.join(' ');
    // Accept employeeRanges or companySizes
    const sizes = searchParams.companySizes || searchParams.employeeRanges || [];
    if (sizes.length > 0) basePayload.organization_num_employees_ranges = sizes;

    // All Koios endpoints to try in order
    const endpoints = [
      { url: 'https://api.apollo.io/v1/mixed_people/search',   label: 'mixed_people' },
      { url: 'https://api.apollo.io/v1/contacts/search',        label: 'contacts' },
      { url: 'https://api.apollo.io/v1/people/search',          label: 'people' },
      { url: 'https://api.apollo.io/api/v1/mixed_people/search',label: 'api/mixed_people' },
      { url: 'https://api.apollo.io/api/v1/contacts/search',    label: 'api/contacts' },
      { url: 'https://api.apollo.io/api/v1/people/search',      label: 'api/people' },
    ];

    // Auth methods to try
    const authVariants = [
      (key) => ({ 'x-api-key': key }),
      (key) => ({ 'X-Api-Key': key }),
      (key) => ({ 'Authorization': 'Bearer ' + key }),
    ];

    const errors = [];

    for (const ep of endpoints) {
      for (const authFn of authVariants) {
        try {
          const payload = Object.assign({}, basePayload);
          const res = await fetch(ep.url, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }, authFn(APOLLO_KEY)),
            body: JSON.stringify(payload)
          });

          if (res.status === 404 || res.status === 405) continue;

          const text = await res.text();

          if (!res.ok) {
            let msg = ep.label + ' ' + res.status;
            try { const d = JSON.parse(text); msg += ': ' + (d.message || d.error || ''); } catch(e) {}
            errors.push(msg);
            continue;
          }

          const data = JSON.parse(text);
          const people = data.people || data.contacts || data.results || [];

          if (!people.length && data.pagination && data.pagination.total_entries === 0) {
            return { statusCode: 200, headers, body: JSON.stringify({ contacts: [], total: 0, page: 1, totalPages: 0, message: 'No contacts found for these filters. Try broader search terms.' }) };
          }

          const contacts = people.map(p => ({
            id:          p.id || Math.random().toString(36).substr(2, 9),
            firstName:   p.first_name  || '',
            lastName:    p.last_name   || '',
            fullName:    p.name        || ((p.first_name||'')+' '+(p.last_name||'')).trim(),
            title:       p.title       || '',
            company:     p.organization ? p.organization.name || '' : '',
            industry:    p.organization ? p.organization.industry || '' : '',
            companySize: p.organization ? String(p.organization.estimated_num_employees || '') : '',
            location:    [p.city, p.state, p.country].filter(Boolean).join(', '),
            email:       p.email        || '',
            emailStatus: p.email_status || '',
            linkedin:    p.linkedin_url || '',
            twitter:     p.twitter_url  || '',
            phone:       p.phone_numbers && p.phone_numbers[0] ? p.phone_numbers[0].sanitized_number || '' : '',
            website:     p.organization ? p.organization.website_url || '' : '',
            source:      'apollo',
            endpoint:    ep.label
          }));

          return { statusCode: 200, headers, body: JSON.stringify({
            contacts,
            total:      data.pagination ? data.pagination.total_entries || contacts.length : contacts.length,
            page:       data.pagination ? data.pagination.page          || 1 : 1,
            totalPages: data.pagination ? data.pagination.total_pages   || 1 : 1,
            endpoint:   ep.label
          })};

        } catch(e) {
          errors.push(ep.label + ': ' + e.message);
          continue;
        }
      }
    }

    // All endpoints failed
    return { statusCode: 403, headers, body: JSON.stringify({
      error: 'Could not access Koios API. Errors: ' + errors.slice(0,3).join(' | ') + '. Please check: 1) APOLLO_API_KEY is correct in Netlify env vars 2) Your API key has search permissions at developer.koios-intel/keys'
    })};
  }

  // ── HUNTER EMAIL FINDER ───────────────────────────────────
  if (action === 'find-email') {
    if (!HUNTER_KEY) return { statusCode: 400, headers, body: JSON.stringify({ error: 'KOIOS_PRIMARY_KEY not configured in Netlify environment variables.' }) };
    const { firstName, lastName, company, domain } = contact;
    if (!firstName || !lastName || (!company && !domain)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'firstName, lastName and company or domain are required' }) };
    try {
      let url = 'https://api.hunter.io/v2/email-finder'
        + '?first_name=' + encodeURIComponent(firstName)
        + '&last_name='  + encodeURIComponent(lastName)
        + '&api_key='    + HUNTER_KEY;
      if (domain)  url += '&domain='  + encodeURIComponent(domain);
      else         url += '&company=' + encodeURIComponent(company);
      const res  = await fetch(url);
      const data = await res.json();
      if (data.data && data.data.email) {
        return { statusCode: 200, headers, body: JSON.stringify({ email: data.data.email, score: data.data.score || 0, source: 'koios-verified' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ email: null, message: 'Email not found by Koios.io' }) };
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Koios.io error: ' + e.message }) };
    }
  }

  // ── LUSHA ENRICHMENT ──────────────────────────────────────
  if (action === 'enrich') {
    if (!LUSHA_KEY) return { statusCode: 400, headers, body: JSON.stringify({ error: 'KOIOS_SECONDARY_KEY not configured in Netlify environment variables.' }) };
    const { firstName, lastName, company } = contact;
    if (!firstName || !lastName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'firstName and lastName are required' }) };
    try {
      let url = 'https://api.lusha.com/person'
        + '?firstName=' + encodeURIComponent(firstName)
        + '&lastName='  + encodeURIComponent(lastName);
      if (company) url += '&company=' + encodeURIComponent(company);
      const res  = await fetch(url, { headers: { 'api_key': LUSHA_KEY } });
      const data = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify({
        email:   data.emailAddresses  && data.emailAddresses[0]  ? data.emailAddresses[0].email           : null,
        phone:   data.phoneNumbers    && data.phoneNumbers[0]    ? data.phoneNumbers[0].localNumber        : null,
        twitter: data.twitterHandle || null,
        linkedin:data.linkedinUrl   || null,
        source: 'koios-enriched'
      })};
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Koios error: ' + e.message }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action. Use: search, find-email, or enrich' }) };
};  // APOLLO PEOPLE MATCH - find email by name + company
  if (action === 'match') {
    if (!APOLLO_KEY) return { statusCode: 200, headers, body: JSON.stringify({ email: null, error: 'Intelligence database not configured' }) };
    const { firstName, lastName, company, linkedinUrl } = contact;
    if (!firstName || !lastName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'firstName and lastName required' }) };
    try {
      const payload = { first_name: firstName, last_name: lastName, reveal_personal_emails: true, reveal_phone_number: false };
      if (company) payload.organization_name = company;
      if (linkedinUrl) payload.linkedin_url = linkedinUrl;
      const res = await fetch('https://api.apollo.io/v1/people/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': APOLLO_KEY },
        body: JSON.stringify(payload)
      });
      if (!res.ok) return { statusCode: 200, headers, body: JSON.stringify({ email: null, message: 'Koios match ' + res.status }) };
      const data = await res.json();
      const person = data.person || {};
      const email = person.email || (person.personal_emails && person.personal_emails[0]) || null;
      return { statusCode: 200, headers, body: JSON.stringify({ email, title: person.title||null, source: 'koios-intel' }) };
    } catch(e) { return { statusCode: 200, headers, body: JSON.stringify({ email: null, error: e.message }) }; }
  }


