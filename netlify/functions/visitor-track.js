// Netlify function: receives website visit events, identifies company via IP
// Stores in Supabase, triggers Koios lookup for decision makers

// Rate limiter
const _rl=new Map();
function _rate(id,max,win){const n=Date.now();const r=_rl.get(id)||{c:0,t:n+(win||60000)};if(n>r.t){r.c=0;r.t=n+(win||60000);}r.c++;_rl.set(id,r);return r.c<=(max||60);}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const _rlip = ip||'unknown';
  if(!_rate(_rlip, 60, 60000)) return {statusCode:429, headers, body:JSON.stringify({error:'Too many requests. Please slow down.'})};

  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
  const CLEARBIT_KEY  = process.env.CLEARBIT_API_KEY;  // optional enrichment
  const IPINFO_TOKEN  = process.env.IPINFO_TOKEN;       // free tier: 50k/month

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) {}

  // Get visitor IP
  const ip = event.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || event.headers['x-real-ip']
    || '0.0.0.0';

  const page     = body.page     || '/';
  const referrer = body.referrer || '';
  const utm      = body.utm      || {};
  const ua       = event.headers['user-agent'] || '';

  // Skip bots
  if (/bot|crawler|spider|scraper|headless/i.test(ua)) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'bot' }) };
  }

  let companyData = {};
  let locationData = {};

  // 1. Get location from IP (IPInfo - free 50k/month)
  try {
    const token = IPINFO_TOKEN ? '?token=' + (IPINFO_TOKEN) : '';
    const ipRes = await fetch('https://ipinfo.io/' + (ip) + '/json' + (token));
    const ipData = await ipRes.json();
    locationData = {
      city:     ipData.city     || '',
      region:   ipData.region   || '',
      country:  ipData.country  || '',
      org:      ipData.org      || '',  // often has company name
      timezone: ipData.timezone || '',
      loc:      ipData.loc      || ''
    };
    // Extract company from org field (format: "AS12345 Company Name")
    if (ipData.org) {
      const parts = ipData.org.split(' ');
      parts.shift(); // remove ASN
      companyData.orgName = parts.join(' ');
    }
  } catch(e) {}

  // 2. Clearbit Reveal for richer company data (if key provided)
  if (CLEARBIT_KEY) {
    try {
      const cbRes = await fetch('https://reveal.clearbit.com/v1/companies/find?ip=' + (ip), {
        headers: { 'Authorization': 'Bearer ' + (CLEARBIT_KEY) }
      });
      if (cbRes.ok) {
        const cbData = await cbRes.json();
        if (cbData.company) {
          companyData = {
            name:     cbData.company.name      || companyData.orgName || '',
            domain:   cbData.company.domain    || '',
            industry: cbData.company.category?.industry || '',
            size:     cbData.company.metrics?.employees || '',
            location: cbData.company.geo?.city + ', ' + cbData.company.geo?.country || '',
            logo:     cbData.company.logo      || '',
            linkedin: cbData.company.linkedin?.handle || '',
            twitter:  cbData.company.twitter?.handle  || '',
            website:  'https://' + (cbData.company.domain || ''),
            type:     cbData.company.type      || '',
            revenue:  cbData.company.metrics?.estimatedAnnualRevenue || ''
          };
        }
      }
    } catch(e) {}
  }

  // 3. Save visit to Supabase
  if (SUPABASE_URL && SERVICE_KEY) {
    try {
      await fetch((SUPABASE_URL) + '/rest/v1/website_visitors', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + (SERVICE_KEY),
          'apikey': SERVICE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          ip,
          page,
          referrer,
          utm_source:   utm.source   || '',
          utm_medium:   utm.medium   || '',
          utm_campaign: utm.campaign || '',
          company_name:     companyData.name     || companyData.orgName || '',
          company_domain:   companyData.domain   || '',
          company_industry: companyData.industry || '',
          company_size:     String(companyData.size || ''),
          company_website:  companyData.website  || '',
          company_linkedin: companyData.linkedin  || '',
          city:     locationData.city    || '',
          region:   locationData.region  || '',
          country:  locationData.country || '',
          timezone: locationData.timezone|| '',
          user_agent: ua.substring(0, 200),
          visited_at: new Date().toISOString()
        })
      });
    } catch(e) { console.error('Supabase save error:', e.message); }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      company: companyData.name || companyData.orgName || 'Unknown',
      location: locationData.city + ', ' + locationData.country
    })
  };
};
