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
  if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured in Netlify environment variables' }) };

  let prompt, company, industry, researchMode;
  try {
    const parsed = JSON.parse(event.body);
    prompt = parsed.prompt;
    company = parsed.company || '';
    industry = parsed.industry || '';
    researchMode = parsed.researchMode || false;
    if (!prompt) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing prompt' }) };
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON: ' + e.message }) };
  }

  try {
    let companyResearch = '';
    let cyberNews = '';

    // Step 1: Research company website if researchMode enabled
    if (researchMode && company) {
      try {
        // Search for company info
        const searchRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1000,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{
              role: 'user',
              content: 'Search for information about the company "' + company + '" in the ' + industry + ' industry. Find: their main business, recent news, compliance challenges, technology they use, and any cybersecurity or data privacy issues they face. Be concise - 150 words max.'
            }]
          })
        });
        const searchData = await searchRes.json();
        // Extract text from response
        if (searchData.content) {
          for (const block of searchData.content) {
            if (block.type === 'text') companyResearch += block.text;
          }
        }
      } catch(e) {
        companyResearch = 'Company research unavailable.';
      }

      // Step 2: Get latest cybersecurity news for their industry
      try {
        const newsRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 500,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{
              role: 'user',
              content: 'Find the 2 most recent cybersecurity threats, data breaches, or compliance regulation changes affecting the ' + industry + ' industry in 2025. Be concise - 100 words max, focus on what a CISO or compliance officer would care about.'
            }]
          })
        });
        const newsData = await newsRes.json();
        if (newsData.content) {
          for (const block of newsData.content) {
            if (block.type === 'text') cyberNews += block.text;
          }
        }
      } catch(e) {
        cyberNews = 'Industry news unavailable.';
      }
    }

    // Step 3: Build enriched prompt
    let enrichedPrompt = prompt;
    if (researchMode && (companyResearch || cyberNews)) {
      enrichedPrompt += '\n\nCOMPANY RESEARCH (use this to personalize the email):\n' + companyResearch;
      enrichedPrompt += '\n\nLATEST CYBERSECURITY NEWS FOR THIS INDUSTRY (weave relevant context naturally into the email):\n' + cyberNews;
      enrichedPrompt += '\n\nIMPORTANT: Use the company research and industry news to make this email hyper-specific. Reference something real about their business or a recent industry threat they would recognize. Do not make up facts — only use what is provided above.';
    }

    // Step 4: Generate the email
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
