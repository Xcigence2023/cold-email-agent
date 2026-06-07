/**
 * video-agent.js — Free AI Video & Image Campaign Engine
 *
 * Images:  Pollinations.ai (FLUX) — 100% free, no key needed
 * Videos:  SadTalker via HuggingFace Spaces — free with free HF account
 * TTS:     HuggingFace TTS models — free with HF_TOKEN
 * Fallback: Script + image only — always free
 */

const _rl = new Map();
function _rate(id, max, win) {
  const n = Date.now(), r = _rl.get(id) || { c: 0, t: n + (win || 60000) };
  if (n > r.t) { r.c = 0; r.t = n + (win || 60000); }
  r.c++; _rl.set(id, r); return r.c <= (max || 15);
}

const HDR = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };
  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!_rate(ip, 15, 60000)) return { statusCode: 429, headers: HDR, body: JSON.stringify({ error: 'Too many requests' }) };

  const HF_TOKEN   = process.env.HF_TOKEN;           // free at huggingface.co — no card
  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;

  let action, payload;
  try { ({ action, payload = {} } = JSON.parse(event.body || '{}')); }
  catch(e) { return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // ── 1. GENERATE IMAGE — Pollinations.ai FLUX — zero cost, no key ────
  if (action === 'generate-image') {
    const {
      industry = '', company = '', tone = 'professional',
      campaignGoal = '', style = 'photorealistic'
    } = payload;

    const styleMap = {
      photorealistic: 'hyperrealistic photography, 8K resolution, professional DSLR, perfect studio lighting',
      cinematic:      'cinematic film shot, anamorphic lens, dramatic shadows, movie poster quality',
      minimal:        'minimalist design, clean white space, flat lay product photography, simple elegance',
      tech:           'futuristic holographic UI, neon blue glow, dark background, sci-fi aesthetic',
      corporate:      'modern corporate office, floor-to-ceiling windows, natural daylight, professional'
    };

    const industryMap = {
      healthcare:     'modern hospital corridor, medical precision, blue and white, clinical excellence',
      finance:        'financial trading floor, glass skyscrapers, stock charts, wealth and stability',
      technology:     'data centre, server racks glowing blue, innovation, digital transformation',
      retail:         'premium retail store, beautiful product display, aspirational lifestyle, clean branding',
      manufacturing:  'precision CNC machinery, factory floor, quality control, industrial strength',
      legal:          'prestigious law office, bookshelves, mahogany, justice and authority',
      education:      'modern open-plan campus, collaborative workspace, bright and inspiring',
      realestate:     'luxury property, architectural photography, beautiful interior design',
      construction:   'impressive infrastructure, aerial construction site, engineering achievement'
    };

    const industryHint = industryMap[(industry || '').toLowerCase()] || 'modern professional business environment, sleek design';
    const styleHint = styleMap[style] || styleMap.photorealistic;
    const prompt = `${industryHint}, ${styleHint}, wide 16:9 composition, no text overlay, no logos, no recognisable faces, suitable for ${campaignGoal || 'B2B marketing campaign'}, photorealistic, award-winning commercial photography`;

    const seed = Math.floor(Math.random() * 9999999);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1792&height=1024&model=flux&seed=${seed}&nologo=true&enhance=true`;

    // Return URL immediately — Pollinations generates on first load
    return {
      statusCode: 200, headers: HDR,
      body: JSON.stringify({ imageUrl, source: 'pollinations-flux', free: true, noKeyRequired: true })
    };
  }

  // ── 2. GENERATE VIDEO SCRIPT — Claude ───────────────────────────────
  if (action === 'generate-script') {
    if (!CLAUDE_KEY) return {
      statusCode: 400, headers: HDR,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured in Netlify env vars' })
    };

    const { recipientName, company, industry, title, senderName, productName } = payload;

    const prompt = `You are a world-class B2B video scriptwriter. Write a 45-60 second personalised sales video script.

RECIPIENT: ${recipientName || 'the recipient'}, ${title || 'Executive'} at ${company || 'their company'} (${industry || 'their industry'})
PRESENTER: ${senderName || 'Alex'} from ${productName || 'Velorah'}

Script rules:
1. Open by saying their name and a genuine specific insight about their industry challenge
2. Acknowledge one real pain point in ONE sentence
3. Explain how ${productName || 'Velorah'} solves it — concrete, not vague, one sentence
4. End with a warm CTA: ask for 15 minutes, no pressure

STRICT: Under 150 words. Conversational tone. No buzzwords. Sound like a real colleague.
Human touches: use contractions (you're, we've, I'd), vary sentence lengths, end casually.

JSON only: {"script":"...","hookLine":"first 12 words","callToAction":"closing sentence","estimatedSeconds":50}`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
      });
      const data = await res.json();
      let txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').replace(/```json|```/g, '').trim();
      const js = txt.indexOf('{'), je = txt.lastIndexOf('}');
      const parsed = js >= 0 && je > js ? JSON.parse(txt.substring(js, je + 1)) : { script: txt };
      return { statusCode: 200, headers: HDR, body: JSON.stringify(parsed) };
    } catch(e) {
      return { statusCode: 500, headers: HDR, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── 3. GENERATE TTS AUDIO — HuggingFace (free HF_TOKEN) ────────────
  if (action === 'generate-tts') {
    if (!HF_TOKEN) return {
      statusCode: 400, headers: HDR,
      body: JSON.stringify({
        error: 'HF_TOKEN not set. Get a free token at huggingface.co/settings/tokens (no credit card)',
        setupUrl: 'https://huggingface.co/settings/tokens'
      })
    };

    const { text, voice = 'female' } = payload;
    if (!text) return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'text required' }) };

    // Use HuggingFace TTS — completely free
    const models = {
      female: 'microsoft/speecht5_tts',
      male:   'facebook/mms-tts-eng'
    };
    const model = models[voice] || models.female;

    try {
      const res = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: text.substring(0, 600) })
      });

      if (!res.ok) {
        const err = await res.text();
        if (err.includes('loading')) return { statusCode: 202, headers: HDR, body: JSON.stringify({ status: 'loading', message: 'Model loading, retry in 20 seconds' }) };
        throw new Error('TTS failed: ' + res.status);
      }

      // Return audio as base64
      const audioBuffer = await res.arrayBuffer();
      const base64Audio = Buffer.from(audioBuffer).toString('base64');
      return {
        statusCode: 200, headers: HDR,
        body: JSON.stringify({ audioBase64: base64Audio, mimeType: 'audio/flac', source: 'huggingface-tts', free: true })
      };
    } catch(e) {
      return { statusCode: 500, headers: HDR, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── 4. CREATE TALKING-HEAD — SadTalker via HuggingFace Space ────────
  if (action === 'create-video') {
    if (!HF_TOKEN) return {
      statusCode: 400, headers: HDR,
      body: JSON.stringify({
        error: 'HF_TOKEN not set. Free at huggingface.co — no credit card needed.',
        setupUrl: 'https://huggingface.co/settings/tokens',
        free: true
      })
    };

    const { imageBase64, audioBase64, mimeType = 'audio/flac' } = payload;
    if (!imageBase64 || !audioBase64) return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'imageBase64 and audioBase64 required' }) };

    try {
      // SadTalker via HuggingFace Spaces Gradio API
      // Space: https://huggingface.co/spaces/vinthony/SadTalker
      const HF_SPACE = 'https://vinthony-sadtalker.hf.space';

      // Upload source image
      const imgBlob = Buffer.from(imageBase64, 'base64');
      const imgForm = new FormData();
      imgForm.append('files', new Blob([imgBlob], { type: 'image/jpeg' }), 'portrait.jpg');
      const imgUp = await fetch(`${HF_SPACE}/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HF_TOKEN}` },
        body: imgForm
      });
      if (!imgUp.ok) throw new Error('Image upload failed: ' + imgUp.status);
      const imgPaths = await imgUp.json();

      // Upload driven audio
      const audBlob = Buffer.from(audioBase64, 'base64');
      const audForm = new FormData();
      audForm.append('files', new Blob([audBlob], { type: mimeType }), 'audio.flac');
      const audUp = await fetch(`${HF_SPACE}/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HF_TOKEN}` },
        body: audForm
      });
      if (!audUp.ok) throw new Error('Audio upload failed: ' + audUp.status);
      const audPaths = await audUp.json();

      // Run SadTalker prediction
      const pred = await fetch(`${HF_SPACE}/run/predict`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fn_index: 0,
          data: [
            { path: imgPaths[0], orig_name: 'portrait.jpg' },
            { path: audPaths[0], orig_name: 'audio.flac' },
            'crop', false, 'facevid2vid', 0.2, false, 0, 'full', 'DAIN_FI', null, true, 256
          ]
        })
      });

      if (!pred.ok) {
        const err = await pred.text();
        throw new Error('SadTalker predict failed: ' + pred.status + ' ' + err.substring(0, 200));
      }

      const result = await pred.json();
      const videoPath = result.data && result.data[0] && (result.data[0].video || result.data[0].path || result.data[0]);
      if (!videoPath) throw new Error('No video path in response');

      const videoUrl = typeof videoPath === 'string'
        ? (videoPath.startsWith('http') ? videoPath : `${HF_SPACE}/file=${videoPath}`)
        : (videoPath.url || `${HF_SPACE}/file=${videoPath.path}`);

      return {
        statusCode: 200, headers: HDR,
        body: JSON.stringify({ videoUrl, source: 'sadtalker-huggingface', free: true })
      };
    } catch(e) {
      return {
        statusCode: 500, headers: HDR,
        body: JSON.stringify({ error: e.message, tip: 'SadTalker may be busy. The Canvas video mode works without any API.' })
      };
    }
  }

  // ── 5. YOUTUBE UPLOAD ────────────────────────────────────────────────
  if (action === 'upload-youtube') {
    const { videoUrl, title, description, accessToken } = payload;
    if (!accessToken) return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Connect YouTube first' }) };

    try {
      const videoRes = await fetch(videoUrl);
      if (!videoRes.ok) throw new Error('Could not fetch video');
      const videoBuffer = await videoRes.arrayBuffer();

      const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': videoBuffer.byteLength
        },
        body: JSON.stringify({
          snippet: { title: (title || 'Campaign Video').substring(0, 100), description: (description || '').substring(0, 5000), categoryId: '22' },
          status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false }
        })
      });
      if (!initRes.ok) { const e = await initRes.json(); throw new Error(e.error?.message || 'YouTube init failed'); }

      const uploadUrl = initRes.headers.get('Location');
      const uploadRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: videoBuffer });
      const uploaded = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploaded.error?.message || 'Upload failed');

      return {
        statusCode: 200, headers: HDR,
        body: JSON.stringify({ success: true, youtubeId: uploaded.id, youtubeUrl: `https://www.youtube.com/watch?v=${uploaded.id}`, shareUrl: `https://youtu.be/${uploaded.id}` })
      };
    } catch(e) {
      return { statusCode: 500, headers: HDR, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
};
