/**
 * video-agent.js -- Ares Video Campaign Engine
 * Place in: netlify/functions/video-agent.js
 *
 * Actions:
 *   generate-image  -- Pollinations.ai FLUX (free, no key)     [not gated: free step]
 *   generate-script -- Claude AI personalised script            [not gated: cheap step]
 *   generate-tts    -- ElevenLabs voiceover (paid)              [GATED: ai_video]
 *   create-video    -- assemble slideshow (the deliverable)     [GATED: ai_video]
 *   upload-youtube  -- YouTube Data API upload                  [GATED: ai_video]
 *
 * Feature gating: AI video is a Pro-tier feature. The paid/deliverable actions
 * require the caller to be a signed-in user whose plan includes `ai_video`.
 * The browser must send the user's Supabase token: Authorization: Bearer <jwt>.
 */
const { assertFeature } = require('./feature-access.js');

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

// Actions that require the ai_video feature (paid / deliverable steps).
const GATED_ACTIONS = ['generate-tts', 'create-video', 'upload-youtube'];

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };
  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!_rate(ip, 15, 60000)) {
    return { statusCode: 429, headers: HDR, body: JSON.stringify({ error: 'Too many requests' }) };
  }
  const CLAUDE_KEY  = process.env.ANTHROPIC_API_KEY || '';
  const HF_TOKEN    = process.env.HF_TOKEN           || '';
  const ELEVEN_KEY  = process.env.ELEVENLABS_API_KEY  || '';
  const ELEVEN_VOICE= process.env.ELEVENLABS_VOICE_ID || 'ZF6FPAbjXT4488VcRRnw';
  const YT_OAUTH    = '';  // passed in payload from browser OAuth
  let action, payload;
  try {
    const body = JSON.parse(event.body || '{}');
    action  = body.action  || '';
    payload = body.payload || {};
  } catch(e) {
    return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // ---- Feature gate: paid/deliverable actions require the ai_video feature ----
  if (GATED_ACTIONS.indexOf(action) !== -1) {
    const auth = event.headers.authorization || event.headers.Authorization;
    const gate = await assertFeature(auth, 'ai_video');
    if (!gate.allowed) {
      return {
        statusCode: 403,
        headers: HDR,
        body: JSON.stringify({
          error: gate.reason === 'unauthenticated'
            ? 'Please sign in to use AI video.'
            : 'AI video is available on the Pro plan. Upgrade to unlock it.',
          feature: 'ai_video',
          upgradeTo: gate.upgradeTo,   // 'pro'
          reason: gate.reason
        })
      };
    }
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
  // -- 3. GENERATE TTS -- ElevenLabs (gated: ai_video) ------
  if (action === 'generate-tts') {
    // ElevenLabs text-to-speech (reliable; same provider as the voice agent).
    if (!ELEVEN_KEY) {
      return { statusCode: 200, headers: HDR, body: JSON.stringify({ error: 'ELEVENLABS_API_KEY not set. Add it in Netlify env vars (from elevenlabs.io). The same account that powers the voice agent works here.', fallback: true }) };
    }
    const { text = '', voice = 'male' } = payload;
    // Keep a sane length cap so generation is fast and within limits.
    const cleanText = String(text).replace(/\s+/g, ' ').trim().substring(0, 1200);
    if (!cleanText) {
      return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'No text provided for voiceover.' }) };
    }
    try {
      const url = 'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(ELEVEN_VOICE) + '?output_format=mp3_44100_128';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVEN_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
          text: cleanText,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
        })
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).substring(0, 200); } catch(e) {}
        return { statusCode: 200, headers: HDR, body: JSON.stringify({ error: 'ElevenLabs TTS failed: ' + res.status + (detail ? ' - ' + detail : ''), fallback: true }) };
      }
      const buf = await res.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      return { statusCode: 200, headers: HDR, body: JSON.stringify({ audioBase64: b64, mimeType: 'audio/mpeg', source: 'elevenlabs' }) };
    } catch(e) {
      return { statusCode: 200, headers: HDR, body: JSON.stringify({ error: 'ElevenLabs error: ' + e.message, fallback: true }) };
    }
  }
  // -- 4. CREATE VIDEO -- assembled in the browser (gated: ai_video) --
  // The old SadTalker HuggingFace Space was unreliable (sleeps/rate-limits/403s).
  // We now assemble a slideshow video client-side from the generated image(s) +
  // ElevenLabs voiceover using Canvas + MediaRecorder. This endpoint just validates
  // inputs and signals the client to render locally.
  if (action === 'create-video') {
    const { imageBase64, audioBase64 } = payload;
    if (!imageBase64 || !audioBase64) {
      return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Both an image and a voiceover are required. Generate the image and the ElevenLabs voiceover first.' }) };
    }
    // Tell the browser to assemble the video locally — no external video service.
    return { statusCode: 200, headers: HDR, body: JSON.stringify({
      assembleInBrowser: true,
      mode: 'slideshow',
      message: 'Image and voiceover ready. Rendering the slideshow video in your browser.'
    }) };
  }
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
