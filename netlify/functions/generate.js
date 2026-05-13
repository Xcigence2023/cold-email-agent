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
      'Calibrate language and statistics to match this company scale.';
  }

  // Helper: call Anthropic with exponential backoff retry for overload
  async function callAnthropic(messages, useSearch, maxTokens, retries) {
    retries = retries || 0;
    const body = {
      model: 'claude-sonnet-4-6',  // Using Sonnet — more reliable, less overloaded
      max_tokens: maxTokens || 800,
      messages
    };
    if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    // Handle overload (529) and rate limit (429) with backoff
    if ((res.status === 529 || res.status === 429) && retries < 3) {
      const waitMs = Math.pow(2, retries) * 3000; // 3s, 6s, 12s
      await new Promise(r => setTimeout(r, waitMs));
      return callAnthropic(messages, useSearch, maxTokens, retries + 1);
    }

    const data = await res.json();
    if (!res.ok) throw new Error('Anthropic error ' + res.status + ': ' + (data.error?.message || JSON.stringify(data)));

    // Extract text from content blocks (handles tool-use responses)
    if (!data.content || !Array.isArray(data.content)) return '';
    return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }

  try {
    let enrichedPrompt = prompt;

    // Research mode — with graceful fallback
    if (researchMode && company) {
      let companyResearch = '';
      let cyberNews = '';

      try {
        companyResearch = await callAnthropic([{
          role: 'user',
          content: 'Search for "' + company + '" company in ' + industry + ' industry. Find their main business, recent news, compliance challenges, and security posture. 120 words max.'
        }], true, 600);
      } catch(e) {
        // Graceful fallback — research failed, continue without it
        console.log('Company research failed, continuing without:', e.message);
        companyResearch = '';
      }

      try {
        cyberNews = await callAnthropic([{
          role: 'user',
          content: 'What are the 2 most recent cybersecurity threats or compliance changes affecting the ' + industry + ' industry in 2025? 80 words max.'
        }], true, 400);
      } catch(e) {
        console.log('News search failed, continuing without:', e.message);
        cyberNews = '';
      }

      if (companyResearch || cyberNews) {
        enrichedPrompt += '\n\nCOMPANY RESEARCH:\n' + (companyResearch || 'Not available') +
          '\n\nLATEST INDUSTRY NEWS:\n' + (cyberNews || 'Not available') +
          '\n\nUSE the above to personalize with real, specific context only.';
      }
      // If both failed, just generate a good email without research — no error thrown
    }

    // Generate final email with retry
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: enrichedPrompt }]
      })
    });

    // Handle overload on final generation
    if (res.status === 529 || res.status === 429) {
      const waitMs = 5000;
      await new Promise(r => setTimeout(r, waitMs));
      const retry = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: enrichedPrompt }] })
      });
      const text = await retry.text();
      return { statusCode: retry.status, headers, body: text };
    }

    const text = await res.text();
    return { statusCode: res.status, headers, body: text };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
