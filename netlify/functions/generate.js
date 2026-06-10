/**
 * generate.js - Optimized AI email generation
 * - Rate limited: 30 requests/minute per user
 * - Input validation and sanitization
 * - Retry on overload with exponential backoff
 * - Parallel research calls
 */

const MAX_PROMPT_LEN  = 8000;
const MAX_COMPANY_LEN = 200;

const rateLimitStore = new Map();
function checkRate(id) {
  const now = Date.now();
  const rec = rateLimitStore.get(id) || { count: 0, resetAt: now + 60000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 60000; }
  rec.count++;
  rateLimitStore.set(id, rec);
  return rec.count <= 30;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Rate limit by IP
  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!checkRate(ip)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Rate limit exceeded. Please wait before generating more emails.' }) };
  }

  let prompt, company, industry, researchMode, companySize, revenue, senderPrefs;
  try {
    const body = JSON.parse(event.body || '{}');
    // Sanitize all inputs
    prompt       = String(body.prompt || '').substring(0, MAX_PROMPT_LEN);
    company      = String(body.company || '').substring(0, MAX_COMPANY_LEN).replace(/[<>]/g, '');
    industry     = String(body.industry || '').substring(0, 100).replace(/[<>]/g, '');
    researchMode = body.researchMode === true;
    companySize  = String(body.companySize || '').substring(0, 50).replace(/[^0-9,+\-\s]/g, '');
    revenue      = String(body.revenue || '').substring(0, 50).replace(/[<>]/g, '');
    senderPrefs  = body.senderPrefs && typeof body.senderPrefs === 'object' ? body.senderPrefs : {};
    if (!prompt) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing prompt' }) };
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'API not configured' }) };

  if (companySize || revenue) {
    prompt += '\n\nCOMPANY SIZE: ' + companySize + (revenue ? ' | Revenue: ' + revenue : '') + '. Calibrate language to this scale.';
  }

  // Claude call with exponential backoff
  async function callClaude(messages, maxTokens, attempt) {
    attempt = attempt || 0;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens || 800, messages })
    });
    if ((res.status === 529 || res.status === 429) && attempt < 3) {
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 4000));
      return callClaude(messages, maxTokens, attempt + 1);
    }
    const data = await res.json();
    if (!res.ok) throw new Error('API error ' + res.status + ': ' + (data.error?.message || ''));
    return data;
  }

  try {
    let enrichedPrompt = prompt;

    // Research mode -- parallel calls, graceful fallback
    if (researchMode && company) {
      const [companyRes, industryRes] = await Promise.allSettled([
        callClaude([{ role: 'user', content: 'In 60 words: what does "' + company + '" do in ' + industry + '? Any recent news?' }], 250),
        callClaude([{ role: 'user', content: 'In 50 words: biggest business risk for ' + industry + ' companies in 2025?' }], 200)
      ]);
      const companyInfo = companyRes.status === 'fulfilled'
        ? (companyRes.value?.content?.[0]?.text || '') : '';
      const industryInfo = industryRes.status === 'fulfilled'
        ? (industryRes.value?.content?.[0]?.text || '') : '';
      if (companyInfo || industryInfo) {
        enrichedPrompt += '\n\nCOMPANY CONTEXT: ' + companyInfo + '\nINDUSTRY RISK: ' + industryInfo + '\nUse one specific detail from above to personalize.';
      }
    }

    // Inject sender preferences into the prompt
    if (senderPrefs && Object.keys(senderPrefs).length > 0) {
      const p = senderPrefs;
      const prefLines = [
        p.name         ? 'Sender name: ' + p.name                                : null,
        p.role         ? 'Sender role/title: ' + p.role                          : null,
        p.company      ? 'Sender company: ' + p.company                          : null,
        p.valueProposition ? 'Your value proposition (state this clearly): ' + p.valueProposition : null,
        p.tone         ? 'TONE -- strictly follow: ' + p.tone                    : null,
        p.emailLength  ? 'Email length target: ' + p.emailLength                 : null,
        p.ctaStyle     ? 'Call-to-action style: ' + p.ctaStyle                   : null,
        p.avoidPhrases ? 'BANNED phrases -- never use: ' + p.avoidPhrases        : null,
        p.socialProof  ? 'Include this social proof naturally: ' + p.socialProof : null,
        p.hook         ? 'Opening hook/angle to use: ' + p.hook                  : null,
      ].filter(Boolean);
      if (prefLines.length > 0) {
        enrichedPrompt += '\nSENDER PROFILE -- FOLLOW EXACTLY:\n' + prefLines.map(function(l) { return '- ' + l; }).join('\n');
      }
    }

    // Add human touch instructions
    enrichedPrompt += '\nHUMAN TOUCH REQUIREMENTS -- MANDATORY:\n- Open with something SPECIFIC and unexpected about their company or role (not generic)\n- Use natural contractions, vary sentence length\n- NO corporate buzzwords: leverage, synergy, scalable, robust\n- End casually: Would it make sense to grab 15 minutes?\n- Sign off with just first name, under 165 words\n- MANDATORY COMPLIANCE: the very last line after the signature must be exactly: If this is not relevant, just reply and I will remove you from my list.';

    const result = await callClaude([{ role: 'user', content: enrichedPrompt }], 1000);
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
