/**
 * social-listen.js -- Athena One Social Lead Discovery
 * Place in: netlify/functions/social-listen.js
 *
 * Platforms: reddit, hackernews, stackoverflow, devto, github, youtube, brave web search
 */

// Rate limiter
const _rl = new Map();
function _rate(id, max, win) {
  const n = Date.now(), r = _rl.get(id) || { c: 0, t: n + (win || 60000) };
  if (n > r.t) { r.c = 0; r.t = n + (win || 60000); }
  r.c++; _rl.set(id, r);
  return r.c <= (max || 20);
}

const HDR = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type':                 'application/json',
  'X-Content-Type-Options':       'nosniff'
};

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!_rate(ip, 20, 60000)) {
    return { statusCode: 429, headers: HDR, body: JSON.stringify({ error: 'Too many requests' }) };
  }

  const YOUTUBE_KEY = process.env.YOUTUBE_API_KEY || '';
  const BRAVE_KEY   = process.env.BRAVE_API_KEY   || '';

  let keywords, platforms, subreddits, limit;
  try {
    const body = JSON.parse(event.body || '{}');
    keywords   = String(body.keywords || '').substring(0, 200).trim();
    platforms  = Array.isArray(body.platforms) ? body.platforms : ['reddit', 'hackernews'];
    subreddits = Array.isArray(body.subreddits) ? body.subreddits : [];
    limit      = Math.min(parseInt(body.limit) || 25, 50);
  } catch(e) {
    return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!keywords) {
    return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'keywords required' }) };
  }

  const results = [];
  const encodedQ = encodeURIComponent(keywords);

  // Safe fetch with 8s timeout
  async function safeFetch(url, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(function() { ctrl.abort(); }, 8000);
    try {
      const r = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      clearTimeout(timer);
      return r;
    } catch(e) {
      clearTimeout(timer);
      return null;
    }
  }

  // Intent detection
  function detectIntent(text) {
    if (!text) return 'discussion';
    const t = text.toLowerCase();
    if (/\b(looking for|need (a |an )?|want to buy|recommend|best (tool|software|platform|service|solution|vendor|app)|any (software|tool|solution|suggestions)|pricing|how much|quote|demo|free trial|alternative to|vs |evaluate)\b/.test(t)) return 'buying';
    if (/\b(problem|issue|help|stuck|can'?t|cannot|struggling|frustrated|broken|failing|not working|challenge|error)\b/.test(t)) return 'problem';
    if (/\b(how (do|can|to)|what is|anyone know|advice|suggestion|thoughts on|opinion|experience with|should i|which is better)\b/.test(t)) return 'asking';
    return 'discussion';
  }

  // -- REDDIT -----------------------------------------------
  if (platforms.includes('reddit')) {
    const urls = subreddits.length > 0
      ? subreddits.map(function(s) {
          return 'https://www.reddit.com/r/' + s + '/search.json?q=' + encodedQ + '&sort=new&limit=' + limit + '&restrict_sr=1';
        })
      : [
          'https://www.reddit.com/search.json?q=' + encodedQ + '&sort=new&limit=' + limit + '&type=link',
          'https://www.reddit.com/search.json?q=' + encodedQ + '&sort=new&limit=15&type=comment'
        ];

    for (var ui = 0; ui < urls.length; ui++) {
      var res = await safeFetch(urls[ui], { headers: { 'User-Agent': 'Velorah/1.0 research-tool' } });
      if (!res || !res.ok) continue;
      try {
        var data = await res.json();
        var posts = data.data && data.data.children ? data.data.children : [];
        posts.forEach(function(p) {
          var d = p.data;
          var isComment = p.kind === 't1';
          results.push({
            id:        'reddit_' + (d.id || Math.random().toString(36).substr(2,8)),
            platform:  'reddit',
            type:      isComment ? 'comment' : 'post',
            title:     isComment ? (d.link_title || (d.body || '').substring(0, 80)) : (d.title || ''),
            snippet:   (d.selftext || d.body || '').substring(0, 400),
            author:    d.author || '',
            authorUrl: 'https://reddit.com/user/' + (d.author || ''),
            url:       'https://reddit.com' + (d.permalink || ''),
            community: d.subreddit ? 'r/' + d.subreddit : '',
            score:     d.score || 0,
            comments:  d.num_comments || 0,
            date:      d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
            intent:    detectIntent((d.title || '') + ' ' + (d.selftext || d.body || ''))
          });
        });
      } catch(e) {}
    }
  }

  // -- HACKER NEWS ------------------------------------------
  if (platforms.includes('hackernews')) {
    var hnRes = await safeFetch('https://hn.algolia.com/api/v1/search?query=' + encodedQ + '&tags=(story,comment)&hitsPerPage=' + limit);
    if (hnRes && hnRes.ok) {
      try {
        var hnData = await hnRes.json();
        (hnData.hits || []).forEach(function(h) {
          results.push({
            id:        'hn_' + h.objectID,
            platform:  'hackernews',
            type:      h._tags && h._tags.includes('comment') ? 'comment' : 'post',
            title:     h.title || h.story_title || (h.comment_text || '').substring(0, 80) || '',
            snippet:   (h.comment_text || h.story_text || '').replace(/<[^>]+>/g, '').substring(0, 400),
            author:    h.author || '',
            authorUrl: 'https://news.ycombinator.com/user?id=' + (h.author || ''),
            url:       h.url || ('https://news.ycombinator.com/item?id=' + h.objectID),
            community: 'Hacker News',
            score:     h.points || 0,
            comments:  h.num_comments || 0,
            date:      h.created_at || null,
            intent:    detectIntent((h.title || '') + ' ' + (h.comment_text || ''))
          });
        });
      } catch(e) {}
    }
  }

  // -- STACK OVERFLOW ---------------------------------------
  if (platforms.includes('stackoverflow')) {
    var soRes = await safeFetch('https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=activity&q=' + encodedQ + '&site=stackoverflow&pagesize=' + Math.min(limit, 25) + '&filter=withbody');
    if (soRes && soRes.ok) {
      try {
        var soData = await soRes.json();
        (soData.items || []).forEach(function(item) {
          results.push({
            id:        'so_' + item.question_id,
            platform:  'stackoverflow',
            type:      'question',
            title:     item.title || '',
            snippet:   (item.body || '').replace(/<[^>]+>/g, '').substring(0, 400),
            author:    item.owner ? (item.owner.display_name || '') : '',
            authorUrl: item.owner ? (item.owner.link || '') : '',
            url:       item.link || '',
            community: 'Stack Overflow',
            score:     item.score || 0,
            comments:  item.answer_count || 0,
            date:      item.creation_date ? new Date(item.creation_date * 1000).toISOString() : null,
            intent:    detectIntent(item.title + ' ' + (item.body || ''))
          });
        });
      } catch(e) {}
    }
  }

  // -- DEV.TO -----------------------------------------------
  if (platforms.includes('devto')) {
    var dtRes = await safeFetch('https://dev.to/api/articles?tag=' + encodedQ + '&per_page=' + Math.min(limit, 30) + '&state=rising');
    if (dtRes && dtRes.ok) {
      try {
        var dtData = await dtRes.json();
        (Array.isArray(dtData) ? dtData : []).forEach(function(a) {
          results.push({
            id:        'devto_' + a.id,
            platform:  'devto',
            type:      'article',
            title:     a.title || '',
            snippet:   (a.description || '').substring(0, 400),
            author:    a.user ? (a.user.name || '') : '',
            authorUrl: a.user ? ('https://dev.to/' + (a.user.username || '')) : '',
            url:       a.url || '',
            community: 'Dev.to',
            score:     a.positive_reactions_count || 0,
            comments:  a.comments_count || 0,
            date:      a.published_at || null,
            intent:    detectIntent(a.title + ' ' + a.description)
          });
        });
      } catch(e) {}
    }
  }

  // -- GITHUB ISSUES ----------------------------------------
  if (platforms.includes('github')) {
    var ghRes = await safeFetch(
      'https://api.github.com/search/issues?q=' + encodedQ + '+type:issue&sort=created&order=desc&per_page=' + Math.min(limit, 30),
      { headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Velorah/1.0' } }
    );
    if (ghRes && ghRes.ok) {
      try {
        var ghData = await ghRes.json();
        (ghData.items || []).forEach(function(issue) {
          results.push({
            id:        'gh_' + issue.id,
            platform:  'github',
            type:      'issue',
            title:     issue.title || '',
            snippet:   (issue.body || '').substring(0, 400),
            author:    issue.user ? (issue.user.login || '') : '',
            authorUrl: issue.user ? (issue.user.html_url || '') : '',
            url:       issue.html_url || '',
            community: issue.repository_url ? issue.repository_url.split('/').slice(-2).join('/') : 'GitHub',
            score:     issue.reactions ? (issue.reactions['+1'] || 0) : 0,
            comments:  issue.comments || 0,
            date:      issue.created_at || null,
            intent:    detectIntent(issue.title + ' ' + (issue.body || ''))
          });
        });
      } catch(e) {}
    }
  }

  // -- YOUTUBE ----------------------------------------------
  if (platforms.includes('youtube') && YOUTUBE_KEY) {
    var ytRes = await safeFetch('https://www.googleapis.com/youtube/v3/search?part=snippet&q=' + encodedQ + '&type=video&order=date&maxResults=' + limit + '&key=' + YOUTUBE_KEY);
    if (ytRes && ytRes.ok) {
      try {
        var ytData = await ytRes.json();
        (ytData.items || []).forEach(function(item) {
          var s = item.snippet;
          results.push({
            id:        'yt_' + item.id.videoId,
            platform:  'youtube',
            type:      'video',
            title:     s.title || '',
            snippet:   (s.description || '').substring(0, 400),
            author:    s.channelTitle || '',
            authorUrl: 'https://youtube.com/channel/' + (s.channelId || ''),
            url:       'https://youtube.com/watch?v=' + item.id.videoId,
            community: 'YouTube',
            score:     0, comments: 0,
            date:      s.publishedAt || null,
            intent:    detectIntent(s.title + ' ' + s.description)
          });
        });
      } catch(e) {}
    }
  } else if (platforms.includes('youtube') && !YOUTUBE_KEY) {
    results.push({
      id: 'yt_setup', platform: 'youtube', type: 'setup',
      title: 'Add YOUTUBE_API_KEY to Netlify env vars for YouTube search',
      snippet: 'Free at console.developers.google.com - YouTube Data API v3 - 10,000 units/day free.',
      author: '', authorUrl: '', url: 'https://console.developers.google.com',
      community: 'YouTube', score: 0, comments: 0, date: null, intent: 'setup'
    });
  }

  // -- BRAVE WEB SEARCH (Facebook/IG/TikTok/Pinterest/Twitter) --
  var webPlatforms = ['facebook','instagram','tiktok','pinterest','twitter','quora','linkedin','producthunt'].filter(function(p) {
    return platforms.includes(p);
  });

  if (webPlatforms.length > 0 && BRAVE_KEY) {
    var siteMap = {
      facebook:  'site:facebook.com',
      instagram: 'site:instagram.com',
      tiktok:    'site:tiktok.com',
      pinterest: 'site:pinterest.com',
      twitter:   'site:twitter.com OR site:x.com',
      quora:     'site:quora.com',
      linkedin:  'site:linkedin.com/posts OR site:linkedin.com/pulse',
      producthunt: 'site:producthunt.com'
    };
    for (var pi = 0; pi < webPlatforms.length; pi++) {
      var p = webPlatforms[pi];
      var q = keywords + ' ' + (siteMap[p] || '');
      var brRes = await safeFetch('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(q) + '&count=20&freshness=pw', {
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': BRAVE_KEY }
      });
      if (brRes && brRes.ok) {
        try {
          var brData = await brRes.json();
          (brData.web && brData.web.results ? brData.web.results : []).forEach(function(item) {
            results.push({
              id:        p + '_' + Math.random().toString(36).substr(2, 8),
              platform:  p,
              type:      'post',
              title:     item.title || '',
              snippet:   (item.description || '').substring(0, 400),
              author:    item.meta_url ? (item.meta_url.hostname || p) : p,
              authorUrl: item.url || '',
              url:       item.url || '',
              community: p.charAt(0).toUpperCase() + p.slice(1),
              score:     0, comments: 0,
              date:      item.age || null,
              intent:    detectIntent(item.title + ' ' + item.description)
            });
          });
        } catch(e) {}
      }
    }
  } else if (webPlatforms.length > 0 && !BRAVE_KEY) {
    // Return search links for manual use
    var searchUrls = {
      facebook:  'https://www.facebook.com/search/posts?q=' + encodedQ,
      instagram: 'https://www.instagram.com/explore/search/keyword/?q=' + encodedQ,
      tiktok:    'https://www.tiktok.com/search?q=' + encodedQ,
      pinterest: 'https://www.pinterest.com/search/pins/?q=' + encodedQ,
      twitter:   'https://twitter.com/search?q=' + encodedQ + '&f=live',
      quora:     'https://www.quora.com/search?q=' + encodedQ,
      linkedin:  'https://www.linkedin.com/search/results/content/?keywords=' + encodedQ,
      producthunt: 'https://www.producthunt.com/search?q=' + encodedQ
    };
    webPlatforms.forEach(function(p) {
      results.push({
        id:        p + '_link',
        platform:  p,
        type:      'search_link',
        title:     'Search ' + p.charAt(0).toUpperCase() + p.slice(1) + ' for: ' + keywords,
        snippet:   'Click to open ' + p + ' search. Add BRAVE_API_KEY to Netlify env vars for automated results.',
        author:    '', authorUrl: '',
        url:       searchUrls[p] || '#',
        community: p.charAt(0).toUpperCase() + p.slice(1),
        score:     0, comments: 0, date: null, intent: 'search_link'
      });
    });
  }

  // Sort: buying > problem > asking > discussion
  var intentRank = { buying: 4, problem: 3, asking: 2, discussion: 1, search_link: 0, setup: 0 };
  results.sort(function(a, b) {
    var diff = (intentRank[b.intent] || 0) - (intentRank[a.intent] || 0);
    if (diff !== 0) return diff;
    return new Date(b.date || 0) - new Date(a.date || 0);
  });

  return {
    statusCode: 200,
    headers: HDR,
    body: JSON.stringify({ results: results.slice(0, 150), total: results.length, platforms: platforms, keywords: keywords })
  };
};
