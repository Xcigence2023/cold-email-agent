exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };

  let prompt, company, industry, researchMode;
  try {
    const parsed = JSON.parse(event.body);
    prompt = parsed.prompt;
    company = parsed.company || '';
    industry = parsed.industry || '';
    researchMode = parsed.researchMode || false;
    const companySize = parsed.companySize || '';
    const revenue = parsed.revenue || '';
    // Inject company size context into prompt if available
    if (companySize || revenue) {
      const sizeContext = '\n\nCOMPANY SIZE CONTEXT: ' +
        (companySize ? 'Employees: ' + companySize + '. ' : '') +
        (revenue ? 'Annual Revenue: ' + revenue + '. ' : '') +
        'Use this to calibrate the language, stakes, and statistics in your email to match their exact scale.';
      prompt = prompt + sizeContext;
    }
    if (!prompt) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing prompt' }) };
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON: ' + e.message }) };
  }

  // Helper: extract text from Anthropic response content blocks
  function extractText(content) {
    if (!content || !Array.isArray(content)) return '';
    return content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
  }

  // Helper: call Anthropic with optional web search tool
  async function callAnthropic(messages, useSearch, maxTokens) {
    const body = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens || 800,
      messages
    };
    if (useSearch) {
      body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return extractText(data.content);
  }

  try {
    let enrichedPrompt = prompt;

    if (researchMode && company) {
      // Research company
      let companyResearch = '';
      let cyberNews = '';

      try {
        companyResearch = await callAnthropic([{
          role: 'user',
          content: 'Search for "' + company + '" company in the ' + industry + ' industry. Find: their main products/services, recent news, compliance or security challenges, and any cybersecurity incidents. Summarize in 120 words max.'
        }], true, 600);
      } catch(e) { companyResearch = ''; }

      try {
        cyberNews = await callAnthropic([{
          role: 'user',
          content: 'What are the 2 most recent cybersecurity threats, data breaches, or new compliance regulations affecting the ' + industry + ' industry in 2025? Summarize in 80 words max.'
        }], true, 400);
      } catch(e) { cyberNews = ''; }

      if (companyResearch || cyberNews) {
        enrichedPrompt += '\n\nCOMPANY RESEARCH:\n' + (companyResearch || 'Not available') +
          '\n\nLATEST CYBERSECURITY NEWS FOR THIS INDUSTRY:\n' + (cyberNews || 'Not available') +
          '\n\nUSE the above to personalize the email with real, specific context. Only reference facts provided above.';
      }
    }

    // Generate the final email
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{ role: 'user', content: enrichedPrompt }]
      })
    });

    const text = await res.text();
    return { statusCode: res.status, headers, body: text };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
