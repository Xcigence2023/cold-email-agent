exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const APOLLO_KEY = process.env.APOLLO_API_KEY;
  const HUNTER_KEY = process.env.HUNTER_API_KEY;
  const LUSHA_KEY  = process.env.LUSHA_API_KEY;

  let action, searchParams, contact;
  try {
    const body = JSON.parse(event.body);
    action = body.action;
    searchParams = body.searchParams || {};
    contact = body.contact || {};
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // APOLLO SEARCH
  if (action === 'search') {
    if (!APOLLO_KEY) return { statusCode: 400, headers, body: JSON.stringify({ error: 'APOLLO_API_KEY not configured in Netlify environment variables' }) };
    const { titles, industries, companySizes, locations, keywords, page, perPage } = searchParams;
    const apolloBody = {
      api_key: APOLLO_KEY,
      page: page || 1,
      per_page: perPage || 25,
      person_titles: titles || ['CISO','CTO','CEO','VP of Security','Chief Security Officer','Chief Cybersecurity Officer','Security Manager','Security Lead','Head of Information Security','Vice President IT']
    };
    if (industries && industries.length)    apolloBody.organization_industry_tag_ids = industries;
    if (companySizes && companySizes.length) apolloBody.organization_num_employees_ranges = companySizes;
    if (locations && locations.length)       apolloBody.person_locations = locations;
    if (keywords)                            apolloBody.q_keywords = keywords;

    try {
      const res = await fetch('https://api.apollo.io/v1/mixed_people/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        body: JSON.stringify(apolloBody)
      });
      const data = await res.json();
      if (!res.ok) return { statusCode: res.status, headers, body: JSON.stringify({ error: data.message || 'Apollo API error ' + res.status }) };
      const contacts = (data.people || []).map(p => ({
        id: p.id, firstName: p.first_name || '', lastName: p.last_name || '',
        fullName: p.name || (p.first_name + ' ' + p.last_name).trim(),
        title: p.title || '', company: p.organization?.name || '',
        industry: p.organization?.industry || '',
        companySize: p.organization?.estimated_num_employees || '',
        location: [p.city, p.country].filter(Boolean).join(', '),
        email: p.email || '', emailStatus: p.email_status || '',
        linkedin: p.linkedin_url || '', twitter: p.twitter_url || '',
        phone: p.phone_numbers?.[0]?.sanitized_number || '',
        website: p.organization?.website_url || '', source: 'apollo'
      }));
      return { statusCode: 200, headers, body: JSON.stringify({ contacts, total: data.pagination?.total_entries || contacts.length, page: data.pagination?.page || 1, totalPages: data.pagination?.total_pages || 1 }) };
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Apollo error: ' + e.message }) };
    }
  }

  // HUNTER EMAIL FIND
  if (action === 'find-email') {
    if (!HUNTER_KEY) return { statusCode: 400, headers, body: JSON.stringify({ error: 'HUNTER_API_KEY not configured' }) };
    const { firstName, lastName, company, domain } = contact;
    if (!firstName || !lastName || (!company && !domain))
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'firstName, lastName, company or domain required' }) };
    try {
      let url = 'https://api.hunter.io/v2/email-finder?first_name=' + encodeURIComponent(firstName) + '&last_name=' + encodeURIComponent(lastName) + '&api_key=' + HUNTER_KEY;
      if (domain) url += '&domain=' + encodeURIComponent(domain);
      else url += '&company=' + encodeURIComponent(company);
      const res = await fetch(url);
      const data = await res.json();
      if (data.data?.email) return { statusCode: 200, headers, body: JSON.stringify({ email: data.data.email, score: data.data.score, status: data.data.verification?.status || 'unknown', source: 'hunter' }) };
      return { statusCode: 200, headers, body: JSON.stringify({ email: null, message: 'Not found' }) };
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Hunter error: ' + e.message }) };
    }
  }

  // LUSHA ENRICH
  if (action === 'enrich') {
    if (!LUSHA_KEY) return { statusCode: 400, headers, body: JSON.stringify({ error: 'LUSHA_API_KEY not configured' }) };
    const { firstName, lastName, company } = contact;
    if (!firstName || !lastName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'firstName and lastName required' }) };
    try {
      let url = 'https://api.lusha.com/person?firstName=' + encodeURIComponent(firstName) + '&lastName=' + encodeURIComponent(lastName);
      if (company) url += '&company=' + encodeURIComponent(company);
      const res = await fetch(url, { headers: { 'api_key': LUSHA_KEY } });
      const data = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify({ email: data.emailAddresses?.[0]?.email || null, phone: data.phoneNumbers?.[0]?.localNumber || null, twitter: data.twitterHandle || null, linkedin: data.linkedinUrl || null, source: 'lusha' }) };
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Lusha error: ' + e.message }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action' }) };
};
