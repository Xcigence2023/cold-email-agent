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
    if (!anthropicKey) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No Anthropic API key. Add it in Step 2 (Configure).' }) };
    if (!prompt) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing prompt' }) };
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON: ' + e.message }) };
  }

  if (companySize || revenue) {
    prompt += '\n\nCOMPANY SIZE: ' + (companySize || 'unknown') + ' employees. Revenue: ' + (revenue || 'unknown') + '. Match all language and statistics to this scale.';
  }

  // Call Anthropic with retry on overload/rate limit
  async function callClaude(messages, maxTokens, attempt) {
    attempt = attempt || 0;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // Fastest model for speed
        max_tokens: maxTokens || 800,
        messages
      })
    });

    if ((res.status === 529 || res.status === 429) && attempt < 3) {
      const wait = (attempt + 1) * 4000; // 4s, 8s, 12s
      await new Promise(r => setTimeout(r, wait));
      return callClaude(messages, maxTokens, attempt + 1);
    }

    const data = await res.json();
    if (!res.ok) throw new Error('API error ' + res.status + ': ' + (data.error?.message || JSON.stringify(data.error)));
    return data;
  }

  try {
    let enrichedPrompt = prompt;

    // Research mode — fast, parallel, graceful fallback
    if (researchMode && company) {
      try {
        // Run company research and news search in PARALLEL (not sequential)
        const [companyResult, newsResult] = await Promise.allSettled([
          callClaude([{
            role: 'user',
            content: 'In 60 words max: what does "' + company + '" do in ' + industry + '? Any recent news or cybersecurity challenges?'
          }], 300),
          callClaude([{
            role: 'user',
            content: 'In 50 words max: biggest cybersecurity or compliance risk for ' + industry + ' companies in 2025?'
          }], 200)
        ]);

        const companyInfo = companyResult.status === 'fulfilled'
          ? companyResult.value?.content?.[0]?.text || '' : '';
        const newsInfo = newsResult.status === 'fulfilled'
          ? newsResult.value?.content?.[0]?.text || '' : '';

        if (companyInfo || newsInfo) {
          enrichedPrompt += '\n\nCOMPANY CONTEXT: ' + companyInfo +
            '\nINDUSTRY RISK: ' + newsInfo +
            '\nUse above to add ONE specific, real detail to personalize the email.';
        }
      } catch(e) {
        // Silently fall through — generate without research
        console.log('Research failed, generating without:', e.message);
      }
    }

    // Generate the email
    const result = await callClaude([{ role: 'user', content: enrichedPrompt }], 1000);

    if (!result.content || !result.content[0]) {
      throw new Error('Empty response from API');
    }

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
