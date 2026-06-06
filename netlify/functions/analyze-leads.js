// AI-powered lead scoring and interest prediction
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return { statusCode: 400, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };

  let leads;
  try { ({ leads } = JSON.parse(event.body)); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!leads || !leads.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No leads provided' }) };

  const prompt = `You are an expert B2B sales analyst. Analyze these email recipients and predict their interest level and likelihood to convert.

For each recipient, score them based on:
- Engagement signals (opened, clicked, re-opened)
- Job title seniority (C-suite > VP > Director > Manager)
- Company size (larger = higher deal value)
- Industry fit for cybersecurity/compliance tools
- Time patterns (opened quickly = more interest)

Recipients:
${leads.map((l, i) => `${i+1}. ${l.name} | ${l.title} | ${l.company} | ${l.industry || 'Unknown'} | ${l.companySize || 'Unknown'} employees | Status: ${l.trackingStatus} | Opens: ${l.openCount || 1} | Clicked: ${l.clicked ? 'Yes' : 'No'} | Subject: "${l.subject}"`).join('\n')}

For EACH recipient provide:
- score: 1-100 (likelihood to convert)
- tier: "hot" | "warm" | "cold"  
- reason: one sharp sentence explaining why
- action: specific next step (e.g. "Call within 24hrs", "Send case study", "Add to nurture sequence")
- interest: predicted interest area based on their role/industry

Respond ONLY with valid JSON array, no markdown:
[{"index":0,"score":85,"tier":"hot","reason":"...","action":"...","interest":"..."}]`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const js = clean.indexOf('['); const je = clean.lastIndexOf(']');
    if (js < 0 || je < 0) throw new Error('Could not parse AI response');
    const predictions = JSON.parse(clean.substring(js, je + 1));
    return { statusCode: 200, headers, body: JSON.stringify({ predictions }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
