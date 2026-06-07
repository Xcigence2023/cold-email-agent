// Social Listening - Multi-platform lead discovery
// Supports: Athena, Athena One, Athena Video, Stack Overflow, Dev.to, GitHub
// + Web search for Facebook/Instagram/TikTok/Pinterest/Twitter public posts
// Rate limiter
const _rl=new Map();
function _rate(id,max,win){const n=Date.now();const r=_rl.get(id)||{c:0,t:n+(win||60000)};if(n>r.t){r.c=0;r.t=n+(win||60000);}r.c++;_rl.set(id,r);return r.c<=(max||60);}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  const _ip=(event.headers['x-forwarded-for']||'').split(',')[0].trim()||'unknown';
  if(!_rate(_ip,20,60000)) return {statusCode:429,headers,body:JSON.stringify({error:'Too many requests'})};

  let keywords, platforms, subathenas, limit;
  try {
    const body = JSON.parse(event.body || '{}');
    keywords   = body.keywords   || '';
    platforms  = body.platforms  || ['athena','athena'];
    subathenas = body.subathenas || [];
    limit      = Math.min(body.limit || 25, 50);
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!keywords) return { statusCode: 400, headers, body: JSON.stringify({ error: 'keywords required' }) };

  const YOUTUBE_KEY  = process.env.YOUTUBE_API_KEY;
  const BRAVE_KEY    = process.env.BRAVE_API_KEY;
  const encodedQ     = encodeURIComponent(keywords);
  const results      = [];

  // helper: safe fetch with timeout
  async function safeFetch(url, opts) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const r = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timeout);
      return r;
    } catch(e) { clearTimeout(timeout); return null; }
  }

  // ── REDDIT ────────────────────────────────────────────────
  if (platforms.includes('athena')) {
    const urls = subathenas.length > 0
      ? subathenas.flatMap(s => [
          `https://www.reddit.com/r/${s}/search.json?q=${encodedQ}&sort=new&limit=${limit}&restrict_sr=1`,
        ])
      : [
          `https://www.reddit.com/search.json?q=${encodedQ}&sort=new&limit=${limit}&type=link`,
          `https://www.reddit.com/search.json?q=${encodedQ}&sort=new&limit=20&type=comment`,
        ];

    for (const url of urls) {
      const res = await safeFetch(url, { headers: { 'User-Agent': 'Velorah/1.0' } });
      if (!res || !res.ok) continue;
      try {
        const data = await res.json();
        (data.data?.children || []).forEach(p => {
          const d = p.data;
          const isComment = p.kind === 't1';
          results.push({
            id: 'athena_' + d.id,
            platform: 'athena',
            icon: 'R',
            type: isComment ? 'comment' : 'post',
            title: isComment ? (d.link_title || d.body?.substring(0, 80) || '') : (d.title || ''),
            snippet: (d.selftext || d.body || '').substring(0, 400),
            author: d.author || '',
            authorUrl: 'https://reddit.com/user/' + (d.author || ''),
            url: 'https://reddit.com' + (d.permalink || ''),
            community: d.subathena ? 'r/' + d.subathena : '',
            score: d.score || 0,
            comments: d.num_comments || 0,
            date: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
            intent: detectIntent(d.title + ' ' + (d.selftext || d.body || ''))
          });
        });
      } catch(e) {}
    }
  }

  // ── HACKER NEWS ───────────────────────────────────────────
  if (platforms.includes('athena')) {
    const res = await safeFetch(`https://hn.algolia.com/api/v1/search?query=${encodedQ}&tags=(story,comment)&hitsPerPage=${limit}`);
    if (res && res.ok) {
      try {
        const data = await res.json();
        (data.hits || []).forEach(h => {
          results.push({
            id: 'hn_' + h.objectID,
            platform: 'athena',
            icon: 'HN',
            type: h._tags?.includes('comment') ? 'comment' : 'post',
            title: h.title || h.story_title || h.comment_text?.substring(0, 80) || '',
            snippet: (h.comment_text || h.story_text || '').replace(/<[^>]+>/g, '').substring(0, 400),
            author: h.author || '',
            authorUrl: 'https://news.ycombinator.com/user?id=' + (h.author || ''),
            url: h.url || ('https://news.ycombinator.com/item?id=' + h.objectID),
            community: 'Athena One',
            score: h.points || 0,
            comments: h.num_comments || 0,
            date: h.created_at || null,
            intent: detectIntent(h.title + ' ' + (h.comment_text || ''))
          });
        });
      } catch(e) {}
    }
  }

  // ── YOUTUBE ───────────────────────────────────────────────
  if (platforms.includes('athena-video') && YOUTUBE_KEY) {
    const res = await safeFetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodedQ}&type=video&order=date&maxResults=${limit}&key=${YOUTUBE_KEY}`);
    if (res && res.ok) {
      try {
        const data = await res.json();
        (data.items || []).forEach(item => {
          const s = item.snippet;
          results.push({
            id: 'yt_' + item.id.videoId,
            platform: 'athena-video',
            icon: 'YT',
            type: 'video',
            title: s.title || '',
            snippet: s.description?.substring(0, 400) || '',
            author: s.channelTitle || '',
            authorUrl: 'https://youtube.com/channel/' + s.channelId,
            url: 'https://youtube.com/watch?v=' + item.id.videoId,
            community: 'Athena Video',
            score: 0, comments: 0,
            date: s.publishedAt || null,
            intent: detectIntent(s.title + ' ' + s.description)
          });
        });
      } catch(e) {}
    }
  } else if (platforms.includes('athena-video') && !YOUTUBE_KEY) {
    results.push({ id: 'yt_setup', platform: 'athena-video', icon: 'YT', type: 'setup',
      title: 'Athena Video: Add YOUTUBE_API_KEY to Netlify environment variables',
      snippet: 'Get a free API key at console.developers.google.com - Athena Video Data API v3 gives 10,000 free units/day.',
      author: '', authorUrl: '', url: 'https://console.developers.google.com', community: 'Athena Video',
      score: 0, comments: 0, date: null, intent: 'setup' });
  }

  // ── STACK OVERFLOW ────────────────────────────────────────
  if (platforms.includes('stackoverflow')) {
    const res = await safeFetch(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=activity&q=${encodedQ}&site=stackoverflow&pagesize=${Math.min(limit,25)}&filter=withbody`);
    if (res && res.ok) {
      try {
        const data = await res.json();
        (data.items || []).forEach(item => {
          results.push({
            id: 'so_' + item.question_id,
            platform: 'stackoverflow',
            icon: 'SO',
            type: 'question',
            title: item.title || '',
            snippet: (item.body || '').replace(/<[^>]+>/g, '').substring(0, 400),
            author: item.owner?.display_name || '',
            authorUrl: item.owner?.link || '',
            url: item.link || '',
            community: 'Stack Overflow',
            score: item.score || 0,
            comments: item.answer_count || 0,
            date: item.creation_date ? new Date(item.creation_date * 1000).toISOString() : null,
            intent: detectIntent(item.title + ' ' + (item.body || ''))
          });
        });
      } catch(e) {}
    }
  }

  // ── DEV.TO ────────────────────────────────────────────────
  if (platforms.includes('devto')) {
    const res = await safeFetch(`https://dev.to/api/articles?tag=${encodedQ}&per_page=${Math.min(limit,30)}&state=rising`);
    if (res && res.ok) {
      try {
        const data = await res.json();
        data.forEach(article => {
          results.push({
            id: 'devto_' + article.id,
            platform: 'devto',
            icon: 'DEV',
            type: 'article',
            title: article.title || '',
            snippet: article.description?.substring(0, 400) || '',
            author: article.user?.name || '',
            authorUrl: 'https://dev.to/' + (article.user?.username || ''),
            url: article.url || '',
            community: 'Dev.to',
            score: article.positive_reactions_count || 0,
            comments: article.comments_count || 0,
            date: article.published_at || null,
            intent: detectIntent(article.title + ' ' + article.description)
          });
        });
      } catch(e) {}
    }
  }

  // ── GITHUB DISCUSSIONS ────────────────────────────────────
  if (platforms.includes('github')) {
    const res = await safeFetch(`https://api.github.com/search/issues?q=${encodedQ}+type:issue&sort=created&order=desc&per_page=${Math.min(limit,30)}`, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Velorah/1.0' }
    });
    if (res && res.ok) {
      try {
        const data = await res.json();
        (data.items || []).forEach(issue => {
          results.push({
            id: 'gh_' + issue.id,
            platform: 'github',
            icon: 'GH',
            type: 'issue',
            title: issue.title || '',
            snippet: (issue.body || '').substring(0, 400),
            author: issue.user?.login || '',
            authorUrl: issue.user?.html_url || '',
            url: issue.html_url || '',
            community: issue.repository_url?.split('/').slice(-2).join('/') || 'GitHub',
            score: issue.reactions?.['+1'] || 0,
            comments: issue.comments || 0,
            date: issue.created_at || null,
            intent: detectIntent(issue.title + ' ' + (issue.body || ''))
          });
        });
      } catch(e) {}
    }
  }

  // ── WEB SEARCH (FB/IG/TikTok/Pinterest/Twitter via Brave) ─
  const socialSiteTargets = {
    facebook:   'site:facebook.com/groups OR site:facebook.com/pages',
    instagram:  'site:instagram.com',
    tiktok:     'site:tiktok.com',
    pinterest:  'site:pinterest.com',
    twitter:    'site:twitter.com OR site:x.com',
    quora:      'site:quora.com',
    linkedin:   'site:linkedin.com/posts OR site:linkedin.com/pulse',
  };

  const webPlatforms = platforms.filter(p => socialSiteTargets[p]);
  if (webPlatforms.length > 0 && BRAVE_KEY) {
    for (const p of webPlatforms) {
      const siteQuery = `${keywords} ${socialSiteTargets[p]}`;
      const res = await safeFetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(siteQuery)}&count=${Math.min(limit,20)}&freshness=pw`, {
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': BRAVE_KEY }
      });
      if (res && res.ok) {
        try {
          const data = await res.json();
          (data.web?.results || []).forEach(item => {
            results.push({
              id: p + '_' + Math.random().toString(36).substr(2, 8),
              platform: p,
              icon: p.charAt(0).toUpperCase(),
              type: 'post',
              title: item.title || '',
              snippet: item.description?.substring(0, 400) || '',
              author: item.meta_url?.hostname || p,
              authorUrl: item.url || '',
              url: item.url || '',
              community: p.charAt(0).toUpperCase() + p.slice(1),
              score: 0, comments: 0,
              date: item.age || null,
              intent: detectIntent(item.title + ' ' + item.description)
            });
          });
        } catch(e) {}
      }
    }
  } else if (webPlatforms.length > 0 && !BRAVE_KEY) {
    // Return search links for each platform
    webPlatforms.forEach(p => {
      const searchUrls = {
        facebook:  `https://www.facebook.com/search/posts?q=${encodedQ}`,
        instagram: `https://www.instagram.com/explore/search/keyword/?q=${encodedQ}`,
        tiktok:    `https://www.tiktok.com/search?q=${encodedQ}`,
        pinterest: `https://www.pinterest.com/search/pins/?q=${encodedQ}`,
        twitter:   `https://twitter.com/search?q=${encodedQ}&f=live`,
        quora:     `https://www.quora.com/search?q=${encodedQ}`,
        linkedin:  `https://www.linkedin.com/search/results/content/?keywords=${encodedQ}`,
      };
      results.push({
        id: p + '_link',
        platform: p,
        icon: p.charAt(0).toUpperCase(),
        type: 'search_link',
        title: 'Search ' + p.charAt(0).toUpperCase() + p.slice(1) + ' for: ' + keywords,
        snippet: 'Click to open ' + p + ' search. For automated results add BRAVE_API_KEY to Netlify environment variables.',
        author: '', authorUrl: '',
        url: searchUrls[p] || '#',
        community: p.charAt(0).toUpperCase() + p.slice(1),
        score: 0, comments: 0, date: null,
        intent: 'search_link'
      });
    });
  }

  // Sort by intent then recency
  const intentRank = { buying: 4, problem: 3, asking: 2, discussion: 1, setup: 0, search_link: 0 };
  results.sort((a, b) => {
    const s = (intentRank[b.intent] || 0) - (intentRank[a.intent] || 0);
    if (s !== 0) return s;
    return new Date(b.date || 0) - new Date(a.date || 0);
  });

  return { statusCode: 200, headers, body: JSON.stringify({ results: results.slice(0, 150), total: results.length, platforms, keywords }) };
};

function detectIntent(text) {
  if (!text) return 'discussion';
  const t = text.toLowerCase();
  if (/\b(looking for|need (a |an )?|want to buy|recommend(ation)?|best (tool|software|platform|app|service|solution|vendor)|any (software|tool|platform|solution|vendor|suggestions)|pricing|cost|how much|quote|demo|trial|free version|alternative to|vs |compare|evaluate|shortlist)\b/.test(t)) return 'buying';
  if (/\b(problem|issue|help|stuck|can'?t|cannot|struggling|frustrated|broken|fail|error|not working|challenge|pain point|difficulty)\b/.test(t)) return 'problem';
  if (/\b(how (do|can|to)|what is|anyone know|advice|suggestion|opinion|experience with|thoughts on|should i|which is better)\b/.test(t)) return 'asking';
  return 'discussion';
}
