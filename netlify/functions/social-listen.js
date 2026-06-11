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


// ============================================================
// COMPETITOR REVIEW INTELLIGENCE (public reviews only)
// Surfaces public reviews, sentiment, pain points, reviewer
// DISPLAY NAME and company (when stated). Never collects
// private contact info -- that is by design and by law.
// ============================================================

var POSITIVE_WORDS = ['love','great','excellent','amazing','best','fantastic','perfect','wonderful','easy','intuitive','reliable','responsive','helpful','recommend','impressed','seamless','smooth','solid','worth','happy','satisfied','game changer','life saver','works well','highly recommend'];
var NEGATIVE_WORDS = ['hate','terrible','awful','worst','horrible','useless','frustrating','disappointed','buggy','slow','expensive','overpriced','confusing','difficult','broken','crash','poor','lacking','missing','unreliable','unresponsive','nightmare','waste','cancel','switching','switched away','looking for alternative','migrated away','regret','avoid','stay away','no support','bad support','ignored'];

var PAIN_CATEGORIES = {
  pricing:      ['expensive','overpriced','cost','pricing','price','billing','charge','refund','hidden fee','too costly','not worth'],
  support:      ['support','customer service','response time','no help','unresponsive','ignored ticket','slow support','no answer'],
  reliability:  ['down','downtime','outage','crash','bug','glitch','unreliable','unstable','broken','error'],
  usability:    ['confusing','complicated','hard to use','unintuitive','clunky','steep learning','difficult to navigate'],
  features:     ['missing feature','lacking','limited','no integration','cannot','does not support','feature request','wish it had'],
  performance:  ['slow','lag','laggy','sluggish','timeout','loading','performance'],
  onboarding:   ['onboarding','setup','migration','implementation','getting started','hard to set up'],
};

function scoreSentiment(text) {
  var t = (text || '').toLowerCase();
  var pos = 0, neg = 0;
  POSITIVE_WORDS.forEach(function(w){ if (t.indexOf(w) >= 0) pos++; });
  NEGATIVE_WORDS.forEach(function(w){ if (t.indexOf(w) >= 0) neg++; });
  var score = pos - neg;
  var label = score > 1 ? 'positive' : score < -1 ? 'negative' : (pos > neg ? 'positive' : neg > pos ? 'negative' : 'mixed');
  return { sentiment: label, posHits: pos, negHits: neg };
}

function extractPainPoints(text) {
  var t = (text || '').toLowerCase();
  var found = [];
  Object.keys(PAIN_CATEGORIES).forEach(function(cat){
    var hit = PAIN_CATEGORIES[cat].some(function(kw){ return t.indexOf(kw) >= 0; });
    if (hit) found.push(cat);
  });
  return found;
}

// Try to extract a company name when the reviewer states their employer.
// Patterns: "we're a <X> company", "at <Company>", "our company <Company>", "as a <role> at <Company>"
function extractCompany(text) {
  if (!text) return '';
  var patterns = [
    /(?:work(?:ing)? at|employed at|i'm at|our company is|as (?:a|an)[^,.]*at)\s+([A-Z][A-Za-z0-9&.\-]+(?:\s[A-Z][A-Za-z0-9&.\-]+){0,2})\b/,
    /\bat\s+([A-Z][A-Za-z0-9&.\-]+(?:\s[A-Z][A-Za-z0-9&.\-]+){0,2})\b/,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = text.match(patterns[i]);
    if (m && m[1]) {
      var c = m[1].trim().split(/[.,;!?]/)[0].trim().replace(/\s+(and|but|or|the|we|i|they|our|my)$/i, '').trim();
      // Filter out common false positives
      if (!/^(the|our|my|this|that|a|an|all|home|work|first|last|least|most|best)$/i.test(c) && c.length > 2) {
        return c;
      }
    }
  }
  return '';
}

// Try to extract company size / industry hints (used to qualify the lead)
function extractFirmographics(text) {
  var t = (text || '').toLowerCase();
  var size = '';
  var sizeMatch = t.match(/(\d{1,3}(?:,\d{3})*)\s*(?:\+\s*)?(?:person|people|employee|staff|seat|user)/);
  if (sizeMatch) size = sizeMatch[1] + ' employees';
  else if (/enterprise|large (?:company|organization|org)|fortune \d/.test(t)) size = 'Enterprise';
  else if (/small business|smb|startup|small team|small company/.test(t)) size = 'SMB';
  else if (/mid.?market|mid.?size/.test(t)) size = 'Mid-market';
  var industry = '';
  var inds = ['healthcare','finance','fintech','saas','ecommerce','retail','manufacturing','logistics','education','legal','real estate','marketing','agency','nonprofit','hospitality','insurance'];
  for (var i=0;i<inds.length;i++){ if (t.indexOf(inds[i])>=0){ industry = inds[i]; break; } }
  return { companySize: size, industry: industry };
}

async function searchReviews(competitor, sentimentFilter, limit, BRAVE_KEY) {
  var results = [];
  var comp = competitor.trim();

  // ---- Source 1: Reddit (people discuss competitor experiences candidly) ----
  try {
    var redditQ = encodeURIComponent('"' + comp + '" (review OR experience OR alternative OR switching OR disappointed OR love OR hate)');
    var rResp = await safeFetch('https://www.reddit.com/search.json?q=' + redditQ + '&sort=relevance&limit=' + Math.min(limit, 25) + '&t=year', {
      headers: { 'User-Agent': 'Velorah-ReviewIntel/1.0' }
    });
    if (rResp) {
      var rData = await rResp.json();
      var children = (rData && rData.data && rData.data.children) || [];
      children.forEach(function(ch){
        var d = ch.data || {};
        var text = (d.selftext || d.title || '');
        if (text.length < 30) return;
        results.push(buildReview('reddit', d.title || '', text, d.author || '', 'https://reddit.com' + (d.permalink || ''), d.created_utc ? new Date(d.created_utc*1000).toISOString() : '', comp));
      });
    }
  } catch(e) {}

  // ---- Source 2: HackerNews (Ask HN / tool discussions) ----
  try {
    var hnResp = await safeFetch('https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(comp) + '&tags=(story,comment)&hitsPerPage=' + Math.min(limit, 20));
    if (hnResp) {
      var hnData = await hnResp.json();
      (hnData.hits || []).forEach(function(hit){
        var text = (hit.comment_text || hit.story_text || hit.title || '').replace(/<[^>]+>/g, '');
        if (text.length < 30) return;
        if (text.toLowerCase().indexOf(comp.toLowerCase()) < 0) return;
        results.push(buildReview('hackernews', hit.title || (text.substring(0,80)), text, hit.author || '', 'https://news.ycombinator.com/item?id=' + (hit.objectID || ''), hit.created_at || '', comp));
      });
    }
  } catch(e) {}

  // ---- Source 3: Public web review search via Brave (G2/Trustpilot/Capterra snippets) ----
  if (BRAVE_KEY) {
    try {
      var braveQ = encodeURIComponent(comp + ' customer reviews complaints (site:g2.com OR site:trustpilot.com OR site:capterra.com OR site:trustradius.com OR site:bbb.org OR site:yelp.com OR site:sitejabber.com OR site:reviews.io OR site:consumeraffairs.com OR site:pissedconsumer.com)');
      var bResp = await safeFetch('https://api.search.brave.com/res/v1/web/search?q=' + braveQ + '&count=' + Math.min(limit, 20), {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      });
      if (bResp) {
        var bData = await bResp.json();
        var webResults = (bData && bData.web && bData.web.results) || [];
        webResults.forEach(function(wr){
          var text = (wr.description || '');
          if (text.length < 30) return;
          var u = (wr.url || '').toLowerCase();
          var platform = u.indexOf('g2.com')>=0 ? 'g2' : u.indexOf('trustpilot')>=0 ? 'trustpilot' : u.indexOf('capterra')>=0 ? 'capterra' : u.indexOf('trustradius')>=0 ? 'trustradius' : u.indexOf('bbb.org')>=0 ? 'bbb' : (u.indexOf('google.com/maps')>=0 || u.indexOf('google.com/search')>=0) ? 'google' : u.indexOf('sitejabber')>=0 ? 'sitejabber' : u.indexOf('reviews.io')>=0 ? 'reviews.io' : u.indexOf('yelp.com')>=0 ? 'yelp' : u.indexOf('consumeraffairs')>=0 ? 'consumeraffairs' : u.indexOf('pissedconsumer')>=0 ? 'pissedconsumer' : 'review-site';
          results.push(buildReview(platform, wr.title || '', text, '', wr.url || '', '', comp));
        });
      }
    } catch(e) {}
  }

  // ---- Source 4: Google Reviews + BBB (targeted via Brave for richer coverage) ----
  if (BRAVE_KEY) {
    try {
      var gbQ = encodeURIComponent('"' + comp + '" customer reviews complaints (site:bbb.org OR site:google.com)');
      var gbResp = await safeFetch('https://api.search.brave.com/res/v1/web/search?q=' + gbQ + '&count=' + Math.min(limit, 15), {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY }
      });
      if (gbResp) {
        var gbData = await gbResp.json();
        var gbResults = (gbData && gbData.web && gbData.web.results) || [];
        gbResults.forEach(function(wr){
          var text = (wr.description || '');
          if (text.length < 30) return;
          var u = (wr.url || '').toLowerCase();
          if (u.indexOf('bbb.org') < 0 && u.indexOf('google.') < 0) return;
          var platform = u.indexOf('bbb.org')>=0 ? 'bbb' : 'google';
          results.push(buildReview(platform, wr.title || '', text, '', wr.url || '', '', comp));
        });
      }
    } catch(e) {}
  }

  // ---- Sentiment filter + dedup ----
  var seen = {};
  results = results.filter(function(r){
    var key = (r.snippet || '').substring(0, 60);
    if (seen[key]) return false;
    seen[key] = true;
    if (sentimentFilter && sentimentFilter !== 'all' && r.sentiment !== sentimentFilter) return false;
    return true;
  });

  // Sort: negative first (best sales signal) when filter is all, else by date
  var sentRank = { negative: 3, mixed: 2, positive: 1 };
  results.sort(function(a, b){
    var d = (sentRank[b.sentiment]||0) - (sentRank[a.sentiment]||0);
    if (d !== 0) return d;
    return (b.painPoints.length) - (a.painPoints.length);
  });

  return results.slice(0, limit);
}

function buildReview(platform, title, text, author, url, date, competitor) {
  var sent = scoreSentiment(text);
  var pains = extractPainPoints(text);
  var company = extractCompany(text);
  var firmo = extractFirmographics(text);
  return {
    id:          Math.random().toString(36).substr(2, 9),
    platform:    platform,
    competitor:  competitor,
    title:       title.substring(0, 120),
    snippet:     text.substring(0, 500),
    author:      author || 'Anonymous reviewer',  // PUBLIC display name only
    authorUrl:   author && platform === 'reddit' ? 'https://reddit.com/user/' + author : '',
    url:         url,
    date:        date,
    sentiment:   sent.sentiment,
    painPoints:  pains,
    company:     company,            // company they work at, IF publicly stated
    companySize: firmo.companySize,
    industry:    firmo.industry,
    // Explicit: no email, no phone, no private data -- by design
    leadReady:   company ? true : false
  };
}


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
    var action     = String(body.action || 'listen');
    var competitor = String(body.competitor || '').substring(0, 80).trim();
    var sentimentFilter = String(body.sentiment || 'all');
  } catch(e) {
    return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // -- COMPETITOR REVIEW INTELLIGENCE MODE --
  if (action === 'reviews') {
    if (!competitor) {
      return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'competitor name required' }) };
    }
    const BRAVE_KEY = process.env.BRAVE_API_KEY || '';
    var reviews = await searchReviews(competitor, sentimentFilter, limit, BRAVE_KEY);
    var summary = {
      total:     reviews.length,
      positive:  reviews.filter(function(r){return r.sentiment==='positive';}).length,
      negative:  reviews.filter(function(r){return r.sentiment==='negative';}).length,
      mixed:     reviews.filter(function(r){return r.sentiment==='mixed';}).length,
      leadReady: reviews.filter(function(r){return r.leadReady;}).length,
      topPains:  {}
    };
    reviews.forEach(function(r){ r.painPoints.forEach(function(p){ summary.topPains[p]=(summary.topPains[p]||0)+1; }); });
    return {
      statusCode: 200,
      headers: HDR,
      body: JSON.stringify({ reviews: reviews, summary: summary, competitor: competitor })
    };
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
