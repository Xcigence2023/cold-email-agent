exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let prompt, company, industry, researchMode, anthropicKey, companySize, revenue;
  try {
    const parsed = JSON.parse(event.body);
    prompt = parsed.prompt;
    company = parsed.company || '';
    industry = parsed.industry || '';
    researchMode = parsed.researchMode || false;
    companySize = parsed.companySize || '';
    revenue = parsed.revenue || '';
    // Use per-user key from request, fall back to env var
    anthropicKey = parsed.anthropicKey || process.env.ANTHROPIC_API_KEY || '';
    if (!anthropicKey) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No Anthropic API key provided. Please add your key in Step 2 (Configure).' }) };
    if (!prompt) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing prompt' }) };
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON: ' + e.message }) };
  }

  // Inject company size context
  if (companySize || revenue) {
    prompt += '\n\nCOMPANY SIZE CONTEXT: ' +
      (companySize ? 'Employees: ' + companySize + '. ' : '') +
      (revenue ? 'Annual Revenue: ' + revenue + '. ' : '') +
      'Calibrate language, stakes, and statistics to match this company\'s scale.';
  }

  function extractText(content) {
    if (!content || !Array.isArray(content)) return '';
    return content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }

  async function callAnthropic(messages, useSearch, maxTokens) {
    const body = { model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens || 800, messages };
    if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error('Anthropic error ' + res.status + ': ' + JSON.stringify(data.error));
    return extractText(data.content);
  }

  try {
    let enrichedPrompt = prompt;

    if (researchMode && company) {
      let companyResearch = '';
      let cyberNews = '';
      try {
        companyResearch = await callAnthropic([{ role: 'user', content: 'Search for "' + company + '" company in ' + industry + ' industry. Find their main business, recent news, compliance challenges, and security posture. 120 words max.' }], true, 600);
      } catch(e) { companyResearch = ''; }
      try {
        cyberNews = await callAnthropic([{ role: 'user', content: 'What are the 2 most recent cybersecurity threats or compliance changes affecting the ' + industry + ' industry in 2025? 80 words max.' }], true, 400);
      } catch(e) { cyberNews = ''; }
      if (companyResearch || cyberNews) {
        enrichedPrompt += '\n\nCOMPANY RESEARCH:\n' + (companyResearch || 'Not available') +
          '\n\nLATEST INDUSTRY CYBERSECURITY NEWS:\n' + (cyberNews || 'Not available') +
          '\n\nUSE the above to personalize the email with specific, real context only.';
      }
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, messages: [{ role: 'user', content: enrichedPrompt }] })
    });

    const text = await res.text();
    return { statusCode: res.status, headers, body: text };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
