/**
 * video-agent.js -- Ares Video Campaign Engine
 * Place in: netlify/functions/video-agent.js
 *
 * Actions:
 *   generate-image  -- Pollinations.ai FLUX (free, no key)
 *   generate-script -- Claude AI personalised script
 *   generate-tts    -- HuggingFace TTS audio (free with HF_TOKEN)
 *   create-video    -- SadTalker via HuggingFace (free with HF_TOKEN)
 *   poll-video      -- check SadTalker job status
 *   upload-youtube  -- YouTube Data API upload
 */

const _rl = new Map();
function _rate(id, max, win) {
  const n = Date.now(), r = _rl.get(id) || { c: 0, t: n + (win || 60000) };
  if (n > r.t) { r.c = 0; r.t = n + (win || 60000); }
  r.c++; _rl.set(id, r);
  return r.c <= (max || 15);
}

const HDR = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Content-Type':                 'application/json',
  'X-Content-Type-Options':       'nosniff'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!_rate(ip, 15, 60000)) {
    return { statusCode: 429, headers: HDR, body: JSON.stringify({ error: 'Too many requests' }) };
  }

  const CLAUDE_KEY  = process.env.ANTHROPIC_API_KEY || '';
  const HF_TOKEN    = process.env.HF_TOKEN           || '';
  const YT_OAUTH    = '';  // passed in payload from browser OAuth

  let action, payload;
  try {
    const body = JSON.parse(event.body || '{}');
    action  = body.action  || '';
    payload = body.payload || {};
  } catch(e) {
    return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // -- 1. GENERATE IMAGE -- Pollinations FLUX (100% free) ---
  if (action === 'generate-image') {
    const { industry = '', company = '', tone = 'professional', campaignGoal = '', style = 'photorealistic' } = payload;

    const styleMap = {
      photorealistic: 'hyperrealistic 8K photography, professional studio lighting, photorealistic',
      cinematic:      'cinematic widescreen shot, dramatic lighting, film quality, award winning photo',
      minimal:        'minimalist clean design, white space, flat product photography, simple elegant',
      tech:           'futuristic holographic display, neon blue glow, dark tech aesthetic, sci-fi',
      corporate:      'modern glass corporate office, natural daylight, professional, trustworthy'
    };

    const industryMap = {
      healthcare:     'modern hospital, medical precision, clinical environment, blue white tones',
      finance:        'financial trading floor, glass skyscrapers, wealth atmosphere, city skyline',
      technology:     'data centre server racks glowing, innovation lab, digital transformation',
      retail:         'premium retail store, aspirational lifestyle, clean branding',
      manufacturing:  'precision factory floor, industrial machinery, quality control',
      legal:          'law office bookshelves, mahogany desk, justice and authority',
      education:      'modern campus, collaborative workspace, open plan learning'
    };

    const ind  = industryMap[(industry || '').toLowerCase()] || 'modern professional business environment';
    const sty  = styleMap[style] || styleMap.photorealistic;
    const seed = Math.floor(Math.random() * 9999999);
    const prompt = ind + ', ' + sty + ', wide 16:9 composition, no text overlay, no logos, no recognisable faces, commercial photography quality';
    // Fallback chain: turbo (free) -> default (free) -> frontend Canvas brand image
    const encPrompt = encodeURIComponent(prompt);
    const imageUrl  = 'https://image.pollinations.ai/prompt/' + encPrompt + '?width=1792&height=1024&model=turbo&seed=' + seed + '&nologo=true';
    const fallbacks = [
      'https://image.pollinations.ai/prompt/' + encPrompt + '?width=1792&height=1024&seed=' + seed + '&nologo=true',
      'https://image.pollinations.ai/prompt/' + encPrompt + '?width=1024&height=576&seed=' + seed,
      'canvas'
    ];

    return { statusCode: 200, headers: HDR, body: JSON.stringify({ imageUrl: imageUrl, fallbacks: fallbacks, source: 'pollinations-turbo', free: true }) };
  }

  // -- 2. GENERATE SCRIPT -- Claude -------------------------
  if (action === 'generate-script') {
    if (!CLAUDE_KEY) return { statusCode: 200, headers: HDR, body: JSON.stringify({ script: 'Hi {{name}}, I wanted to reach out about how we can help {{company}} with their challenges. Would you be open to a 15-minute call?', hookLine: 'Quick personalised message', callToAction: 'Open to a 15-minute call?', estimatedSeconds: 45 }) };

    const { recipientName = 'there', company = 'your company', industry = '', title = '', senderName = 'Alex', productName = 'Velorah' } = payload;

    const prompt = 'Write a 45-60 second B2B video script. RECIPIENT: ' + recipientName + ', ' + title + ' at ' + company + ' (' + industry + '). PRESENTER: ' + senderName + ' from ' + productName + '. Rules: Open with their name and a specific industry insight. Identify one real pain point. Show how ' + productName + ' solves it. End with a soft CTA for a 15-min call. Under 150 words. Conversational, no buzzwords. JSON only: {"script":"...","hookLine":"first 12 words","callToAction":"closing line","estimatedSeconds":50}';

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
      });
      const data = await res.json();
      let txt = (data.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('').replace(/```json|```/g, '').trim();
      const js = txt.indexOf('{'), je = txt.lastIndexOf('}');
      const parsed = (js >= 0 && je > js) ? JSON.parse(txt.substring(js, je + 1)) : { script: txt, hookLine: '', callToAction: '', estimatedSeconds: 50 };
      return { statusCode: 200, headers: HDR, body: JSON.stringify(parsed) };
    } catch(e) {
      return { statusCode: 200, headers: HDR, body: JSON.stringify({ script: 'Hi ' + recipientName + ', wanted to reach out personally about ' + company + '. Would love to show you what we have built. Open for a quick 15 min call?', hookLine: 'Personal outreach', callToAction: 'Open for a 15 min call?', estimatedSeconds: 30 }) };
    }
  }

  // -- 3. GENERATE TTS -- HuggingFace (free with HF_TOKEN) --
  if (action === 'generate-tts') {
    if (!HF_TOKEN) {
      return { statusCode: 200, headers: HDR, body: JSON.stringify({ error: 'HF_TOKEN not set. Add it in Netlify env vars (free at huggingface.co/settings/tokens). Using canvas mode instead.', fallback: true }) };
    }

    const { text = '', voice = 'female' } = payload;
    const cleanText = text.replace(/[^\w\s.,!?'-]/g, ' ').substring(0, 600);

    try {
      const modelUrl = voice === 'female'
        ? 'https://api-inference.huggingface.co/models/microsoft/speecht5_tts'
        : 'https://api-inference.huggingface.co/models/facebook/mms-tts-eng';

      const res = await fetch(modelUrl, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + HF_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: cleanText })
      });

      if (res.status === 503) {
        const d = await res.json().catch(function() { return {}; });
        const wait = d.estimated_time ? Math.ceil(d.estimated_time) : 20;
        return { statusCode: 200, headers: HDR, body: JSON.stringify({ loading: true, message: 'TTS model loading, retry in ' + wait + 's', waitSeconds: wait }) };
      }

      if (!res.ok) {
        return { statusCode: 200, headers: HDR, body: JSON.stringify({ error: 'TTS failed: ' + res.status, fallback: true }) };
      }

      const buf = await res.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      return { statusCode: 200, headers: HDR, body: JSON.stringify({ audioBase64: b64, mimeType: 'audio/flac', source: 'huggingface-tts' }) };

    } catch(e) {
      return { statusCode: 200, headers: HDR, body: JSON.stringify({ error: e.message, fallback: true }) };
    }
  }

  // -- 4. CREATE VIDEO -- SadTalker via HuggingFace ---------
  if (action === 'create-video') {
    if (!HF_TOKEN) {
      return { statusCode: 200, headers: HDR, body: JSON.stringify({ error: 'HF_TOKEN not configured. Get a free token at huggingface.co (no credit card). Or use Canvas mode -- it works with zero accounts.', setupUrl: 'https://huggingface.co/settings/tokens' }) };
    }

    const { imageBase64, audioBase64, mimeType = 'audio/flac' } = payload;

    if (!imageBase64 || !audioBase64) {
      return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'imageBase64 and audioBase64 required. Upload a portrait photo and ensure TTS generation succeeded first.' }) };
    }

    const HF_SPACE = 'https://vinthony-sadtalker.hf.space';

    try {
      // Upload portrait image
      const imgBlob = Buffer.from(imageBase64, 'base64');
      const imgFormData = new FormData();
      imgFormData.append('files', new Blob([imgBlob], { type: 'image/jpeg' }), 'portrait.jpg');

      const imgUp = await fetch(HF_SPACE + '/upload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + HF_TOKEN },
        body: imgFormData
      });
      if (!imgUp.ok) throw new Error('Image upload to HF failed: ' + imgUp.status);
      const imgPaths = await imgUp.json();

      // Upload audio
      const audBlob = Buffer.from(audioBase64, 'base64');
      const audFormData = new FormData();
      audFormData.append('files', new Blob([audBlob], { type: mimeType }), 'audio.flac');

      const audUp = await fetch(HF_SPACE + '/upload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + HF_TOKEN },
        body: audFormData
      });
      if (!audUp.ok) throw new Error('Audio upload to HF failed: ' + audUp.status);
      const audPaths = await audUp.json();

      // Run SadTalker
      const pred = await fetch(HF_SPACE + '/run/predict', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + HF_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fn_index: 0,
          data: [
            { path: imgPaths[0], orig_name: 'portrait.jpg' },
            { path: audPaths[0], orig_name: 'audio.flac' },
            'crop', false, 'facevid2vid', 0.2, false, 0, 'full', 'DAIN_FI', null, true, 256
          ]
        })
      });

      if (!pred.ok) throw new Error('SadTalker predict failed: ' + pred.status);
      const result = await pred.json();

      const videoPath = result.data && result.data[0];
      if (!videoPath) throw new Error('No video in SadTalker response');

      const videoUrl = typeof videoPath === 'string'
        ? (videoPath.startsWith('http') ? videoPath : HF_SPACE + '/file=' + videoPath)
        : (videoPath.url || HF_SPACE + '/file=' + videoPath.path);

      return { statusCode: 200, headers: HDR, body: JSON.stringify({ videoUrl: videoUrl, source: 'sadtalker-huggingface' }) };

    } catch(e) {
      return { statusCode: 200, headers: HDR, body: JSON.stringify({ error: e.message + '. SadTalker may be temporarily overloaded. Try Canvas mode -- it works instantly with zero accounts.', sadtalkerFailed: true }) };
    }
  }

  // -- 5. UPLOAD TO YOUTUBE ----------------------------------
  if (action === 'upload-youtube') {
    const { videoUrl, title, description, accessToken } = payload;
    if (!accessToken) return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'YouTube access token required. Connect YouTube in Step 1.' }) };

    try {
      const videoRes = await fetch(videoUrl);
      if (!videoRes.ok) throw new Error('Could not fetch video from source');
      const videoBuffer = await videoRes.arrayBuffer();

      const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(videoBuffer.byteLength)
        },
        body: JSON.stringify({
          snippet: { title: (title || 'Ares Campaign Video').substring(0, 100), description: (description || '').substring(0, 5000), categoryId: '22' },
          status:  { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false }
        })
      });
      if (!initRes.ok) { const e = await initRes.json(); throw new Error(e.error ? e.error.message : 'YouTube init failed'); }

      const uploadUrl = initRes.headers.get('Location');
      const uploadRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: videoBuffer });
      const uploaded = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploaded.error ? uploaded.error.message : 'Upload failed');

      return { statusCode: 200, headers: HDR, body: JSON.stringify({ success: true, youtubeId: uploaded.id, youtubeUrl: 'https://www.youtube.com/watch?v=' + uploaded.id, shareUrl: 'https://youtu.be/' + uploaded.id }) };
    } catch(e) {
      return { statusCode: 200, headers: HDR, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
};
