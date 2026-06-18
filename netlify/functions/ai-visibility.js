/**
 * ai-visibility.js -- Netlify Function: AI Visibility / GEO analysis
 * Place in: netlify/functions/ai-visibility.js
 *
 * Helps a Velorah customer understand and improve how likely AI models
 * (ChatGPT, Claude, Gemini, Copilot, Perplexity) are to surface their
 * company when users ask relevant questions.
 *
 * It does this LEGITIMATELY -- not by "buying placement" (which doesn't
 * exist) but by analyzing the company's public web presence the way a
 * retrieval-augmented model would, and giving concrete, actionable
 * recommendations (structured data, authoritative content, etc).
 *
 * Actions:
 *   analyze -- fetch the company's site, score AI-readiness, return recommendations
 *   simulate -- ask Claude what it "knows" about the company (visibility probe)
 *
 * ENV: ANTHROPIC_API_KEY  (optional: BRAVE_API_KEY for web presence check)
 */

const HDR = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function ok(d){ return { statusCode: 200, headers: HDR, body: JSON.stringify(d) }; }
function err(m, c){ return { statusCode: c || 400, headers: HDR, body: JSON.stringify({ error: m }) }; }

// Rate limiter
const _rl = new Map();
function _rate(id, max, win){
  const n = Date.now();
  const r = _rl.get(id) || { c: 0, t: n + (win||60000) };
  if(n > r.t){ r.c = 0; r.t = n + (win||60000); }
  r.c++; _rl.set(id, r);
  return r.c <= (max||20);
}

async function fetchSite(url){
  try{
    const ctrl = new AbortController();
    const timer = setTimeout(function(){ ctrl.abort(); }, 8000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelorahBot/1.0)' } });
    clearTimeout(timer);
    if(!r.ok) return null;
    return await r.text();
  }catch(e){ return null; }
}

// Analyze raw HTML for AI-readiness signals
function analyzeHtml(html, domain){
  const findings = [];
  let score = 0;
  const maxScore = 100;

  const has = function(re){ return re.test(html); };

  // 1. Structured data (JSON-LD / schema.org) -- huge for AI retrieval
  if(has(/application\/ld\+json/i) || has(/schema\.org/i)){
    score += 20; findings.push({ ok: true, area: 'Structured data', note: 'Schema.org / JSON-LD markup found. This helps AI models parse who you are and what you do.' });
  } else {
    findings.push({ ok: false, area: 'Structured data', note: 'No schema.org/JSON-LD markup found. Add Organization, Product, and FAQ structured data -- AI models lean heavily on this to understand and cite a business.' });
  }

  // 2. Meta description
  if(has(/<meta[^>]+name=["']description["'][^>]+content=/i)){
    score += 10; findings.push({ ok: true, area: 'Meta description', note: 'Meta description present.' });
  } else {
    findings.push({ ok: false, area: 'Meta description', note: 'Missing meta description. Add a clear one-sentence description of what the company does.' });
  }

  // 3. Title tag
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if(titleMatch && titleMatch[1].trim().length > 10){
    score += 8; findings.push({ ok: true, area: 'Title tag', note: 'Descriptive title tag present: "' + titleMatch[1].trim().slice(0,60) + '"' });
  } else {
    findings.push({ ok: false, area: 'Title tag', note: 'Title tag missing or too short. Make it descriptive of the company and its core offering.' });
  }

  // 4. Headings structure
  const h1count = (html.match(/<h1[^>]*>/gi) || []).length;
  if(h1count >= 1){
    score += 8; findings.push({ ok: true, area: 'Heading structure', note: h1count + ' H1 heading(s) found. Clear headings help models extract topics.' });
  } else {
    findings.push({ ok: false, area: 'Heading structure', note: 'No H1 heading found. Use a clear H1 stating what the company does.' });
  }

  // 5. FAQ content (models love Q&A format)
  if(has(/\bFAQ\b/i) || has(/frequently asked/i) || has(/FAQPage/i)){
    score += 12; findings.push({ ok: true, area: 'FAQ content', note: 'FAQ-style content detected. Q&A format is highly citable by AI models.' });
  } else {
    findings.push({ ok: false, area: 'FAQ content', note: 'No FAQ content found. Add an FAQ page answering the real questions buyers ask -- this is one of the most effective ways to get cited by AI.' });
  }

  // 6. About / clear entity definition
  if(has(/about us/i) || has(/who we are/i) || has(/our mission/i)){
    score += 8; findings.push({ ok: true, area: 'Entity clarity', note: 'About/company info present.' });
  } else {
    findings.push({ ok: false, area: 'Entity clarity', note: 'Add a clear "About" section defining the company, its category, and who it serves.' });
  }

  // 7. Open Graph (helps with how content is represented)
  if(has(/property=["']og:/i)){
    score += 6; findings.push({ ok: true, area: 'Open Graph', note: 'Open Graph tags present.' });
  } else {
    findings.push({ ok: false, area: 'Open Graph', note: 'Add Open Graph meta tags for better representation when shared and parsed.' });
  }

  // 8. Sitemap / robots hints
  if(has(/sitemap/i)){
    score += 5; findings.push({ ok: true, area: 'Sitemap', note: 'Sitemap reference found.' });
  } else {
    findings.push({ ok: false, area: 'Sitemap', note: 'Ensure a sitemap.xml exists and is referenced -- helps crawlers and retrieval indexes find all your content.' });
  }

  // 9. Content depth (rough proxy)
  const textLen = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
  if(textLen > 2000){
    score += 8; findings.push({ ok: true, area: 'Content depth', note: 'Substantial page content. Depth and specificity make a page more citable.' });
  } else {
    findings.push({ ok: false, area: 'Content depth', note: 'Thin page content. AI models cite specific, substantive content -- add detailed, authoritative pages about your offering.' });
  }

  // 10. Author / authority signals
  if(has(/author/i) || has(/byline/i)){
    score += 7; findings.push({ ok: true, area: 'Authority signals', note: 'Author/byline signals found.' });
  } else {
    findings.push({ ok: false, area: 'Authority signals', note: 'Add author attribution and expertise signals (team bios, credentials). Models weight authoritative, attributable sources.' });
  }

  return { score: Math.min(score, maxScore), findings: findings };
}

exports.handler = async function(event){
  if(event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };
  if(event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
  if(!_rate(ip, 20, 60000)) return err('Too many requests', 429);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch(e){ return err('Invalid JSON'); }

  const action = body.action || 'analyze';
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  // ---- ANALYZE: fetch the site and score AI-readiness ----
  if(action === 'analyze'){
    let domain = (body.domain || body.url || '').trim();
    if(!domain) return err('A company website/domain is required');
    // Normalize to a URL
    if(!/^https?:\/\//i.test(domain)) domain = 'https://' + domain;

    const html = await fetchSite(domain);
    if(html === null){
      return ok({
        reachable: false,
        score: 0,
        findings: [{ ok: false, area: 'Reachability', note: 'Could not fetch the site. Check the domain is correct and publicly reachable.' }],
        recommendations: ['Confirm the website URL is correct and live.']
      });
    }

    const analysis = analyzeHtml(html, domain);

    // Build prioritized recommendations from the failed findings
    const recs = analysis.findings.filter(function(f){ return !f.ok; }).map(function(f){ return f.note; });

    let grade = 'Needs work';
    if(analysis.score >= 80) grade = 'Excellent';
    else if(analysis.score >= 60) grade = 'Good';
    else if(analysis.score >= 40) grade = 'Fair';

    return ok({
      reachable: true,
      domain: domain,
      score: analysis.score,
      grade: grade,
      findings: analysis.findings,
      recommendations: recs
    });
  }

  // ---- SIMULATE: probe what an AI model "knows" about the company ----
  if(action === 'simulate'){
    if(!ANTHROPIC_KEY) return err('AI probe is not configured (ANTHROPIC_API_KEY missing)');
    const company = (body.company || '').trim();
    if(!company) return err('Company name required');

    const prompt = 'A user is researching companies in this space. Based only on what you reliably know, answer concisely:\n'
      + '1. Have you heard of the company "' + company + '"? (yes/no/uncertain)\n'
      + '2. If yes, what do you know about what they do?\n'
      + '3. If a buyer asked you to recommend companies like this, would "' + company + '" come to mind? Why or why not?\n'
      + 'Be honest about uncertainty. This is to help the company understand their AI visibility.';

    try{
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
      });
      const d = await resp.json();
      const txt = (d.content || []).filter(function(b){ return b.type === 'text'; }).map(function(b){ return b.text; }).join('');
      return ok({ company: company, probe: txt });
    }catch(e){
      return err('AI probe failed: ' + e.message);
    }
  }

  return err('Unknown action');
};
