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

var POSITIVE_WORDS = {
  // strong positive (weight 3)
  'highly recommend':3,'love it':3,'best decision':3,'game changer':3,'life saver':3,'could not be happier':3,'couldnt be happier':3,'absolutely love':3,'exceeded expectations':3,'worth every penny':3,
  // medium positive (weight 2)
  'love':2,'excellent':2,'amazing':2,'fantastic':2,'perfect':2,'wonderful':2,'seamless':2,'intuitive':2,'impressed':2,'recommend':2,'reliable':2,'responsive':2,'saves us':2,'saves me':2,'saved us':2,'time saver':2,
  // mild positive (weight 1)
  'great':1,'best':1,'easy':1,'helpful':1,'smooth':1,'solid':1,'worth':1,'happy':1,'satisfied':1,'works well':1,'works great':1,'no complaints':1,'does what we need':1,'does the job':1,'pleased':1,'glad':1,'fine':1
};
var NEGATIVE_WORDS = {
  // strong negative (weight 3) -- high-intent churn / complaint signals
  'looking for alternative':3,'looking for an alternative':3,'switching away':3,'switched away':3,'migrated away':3,'migrating away':3,'moving away':3,'stay away':3,'do not recommend':3,'dont recommend':3,'would not recommend':3,'nightmare':3,'worst':3,'lost access':3,'lost sales':3,'cost us':3,'refused refund':3,'refused to refund':3,'charged twice':3,'kept charging':3,'avoid this':3,'cancelled my':3,'cancel my':3,'regret':3,'terrible customer service':3,'non-existent':3,'nonexistent':3,
  // medium negative (weight 2)
  'terrible':2,'awful':2,'horrible':2,'useless':2,'frustrating':2,'frustrated':2,'disappointed':2,'disappointing':2,'unreliable':2,'unresponsive':2,'overpriced':2,'too expensive':2,'hidden fees':2,'waste':2,'broken':2,'crash':2,'crashes':2,'outage':2,'outages':2,'downtime':2,'ignored':2,'no support':2,'bad support':2,'poor support':2,'avoid':2,'hate':2,'switching':2,'cancelled':2,'cancel':2,'refund':2,
  // mild negative (weight 1)
  'buggy':1,'slow':1,'expensive':1,'confusing':1,'difficult':1,'hard to use':1,'poor':1,'lacking':1,'missing':1,'clunky':1,'steep learning':1,'learning curve':1,'complicated':1,'issue':1,'issues':1,'problem':1,'problems':1,'glitch':1,'lag':1
};

var LOVE_CATEGORIES = {
  'ease of use':     ['easy to use','intuitive','user friendly','user-friendly','simple to','straightforward','easy to set up','easy setup'],
  'support':         ['great support','excellent support','helpful support','responsive support','support team is','support was great','quick to respond'],
  'value':           ['worth the','great value','good value','worth every penny','affordable','reasonable price','cost effective','cost-effective'],
  'reliability':     ['reliable','stable','dependable','never goes down','always works','rock solid','solid platform'],
  'features':        ['feature rich','feature-rich','powerful','robust','comprehensive','everything we need','lots of features','great features'],
  'integrations':    ['integrates well','great integration','easy integration','works with','seamless integration','connects to'],
  'onboarding':      ['easy onboarding','smooth onboarding','quick to implement','fast setup','painless setup','easy to implement'],
  'reporting':       ['great reporting','insightful','great dashboards','clear reports','useful analytics','actionable insights']
};

var PAIN_CATEGORIES = {
  pricing:      ['expensive','overpriced','too costly','cost is','costs too','pricing adds up','price increase','price hike','billing issue','billing problem','billed','charged','overcharged','hidden fee','hidden fees','refund','not worth the','cost us','hard to justify'],
  support:      ['poor support','bad support','no support','slow support','terrible support','support ignored','support never','customer service was','customer service is non','unresponsive','no help','no answer','ignored ticket','ignored our','tickets ignored','support team ignored','support was a nightmare','support is non'],
  reliability:  ['downtime','outage','outages','crash','crashes','crashed','bug','bugs','buggy','glitch','unreliable','unstable','broken','went down','lost access','keeps crashing','constant errors','frequent errors'],
  usability:    ['confusing','complicated','hard to use','unintuitive','clunky','steep learning','learning curve','difficult to navigate','hard to navigate','not intuitive','overly complex'],
  features:     ['missing feature','missing features','lacking','feature is missing','no integration','lacks integration','does not support','doesnt support','cannot do','wish it had','limited functionality','feature request'],
  performance:  ['slow','laggy','sluggish','timeout','times out','too slow','very slow','performance issue','loading forever'],
  onboarding:   ['onboarding was','hard to set up','difficult to set up','setup was','migration was','implementation was','painful to configure','weeks to configure','configuring basic'],
};

function scoreSentiment(text) {
  var t = (text || '').toLowerCase();
  // normalise punctuation/whitespace so phrase matching is reliable
  t = t.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');

  var pos = 0, neg = 0, posHits = 0, negHits = 0;

  // Negation cues: if a positive word is negated, it flips to negative signal
  function isNegated(idx) {
    var before = t.substring(Math.max(0, idx - 22), idx);
    return /\b(not|no|never|isn'?t|wasn'?t|aren'?t|don'?t|doesn'?t|didn'?t|can'?t|cannot|hardly|barely|lack of|far from)\s+[\w']*\s?$/.test(before);
  }

  // Score positive terms (weighted), respecting negation
  Object.keys(POSITIVE_WORDS).forEach(function(w){
    var idx = t.indexOf(w);
    if (idx >= 0) {
      var wt = POSITIVE_WORDS[w];
      if (isNegated(idx)) { neg += wt; negHits++; }   // "not reliable" -> negative
      else { pos += wt; posHits++; }
    }
  });

  // Score negative terms (weighted); negated negatives are softened, not flipped
  Object.keys(NEGATIVE_WORDS).forEach(function(w){
    var idx = t.indexOf(w);
    if (idx >= 0) {
      var wt = NEGATIVE_WORDS[w];
      if (isNegated(idx)) { pos += 1; }               // "no problems" -> slight positive
      else { neg += wt; negHits++; }
    }
  });

  // Churn-intent override: explicit switching/leaving language is decisively negative
  var churnIntent = /(looking for (an? )?alternative|switching away|switched away|migrat(ing|ed) away|moving away|stay away|do(es)? ?n'?t recommend|cancel(led|ling)? (my|our|the)|refused (to )?refund)/.test(t);
  if (churnIntent) neg += 3;

  var score = pos - neg;
  var label;
  if (churnIntent && neg > pos) label = 'negative';
  else if (score >= 2) label = 'positive';
  else if (score <= -2) label = 'negative';
  else if (neg > pos) label = 'negative';
  else if (pos > neg) label = 'positive';
  else label = 'mixed';

  return { sentiment: label, posHits: posHits, negHits: negHits, posScore: pos, negScore: neg };
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

function extractLovePoints(text) {
  var t = (text || '').toLowerCase();
  var found = [];
  Object.keys(LOVE_CATEGORIES).forEach(function(cat){
    var hit = LOVE_CATEGORIES[cat].some(function(kw){ return t.indexOf(kw) >= 0; });
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

async function safeFetch(url, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(function() { ctrl.abort(); }, 6000);
    try {
      const r = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
      clearTimeout(timer);
      return r;
    } catch(e) {
      clearTimeout(timer);
      return null;
    }
  }

async function searchReviews(competitor, sentimentFilter, limit, BRAVE_KEY) {
  var results = [];
  var comp = competitor.trim();
  var maxPer = Math.min(limit || 50, 50);

  // ============================================================
  // STRATEGY: Brave web search is the primary engine. Instead of
  // restrictive 'site:' filters (which return near-zero), we run
  // several BROAD review-intent queries, then classify each result
  // by its domain after the fact. This surfaces G2, Trustpilot,
  // Gartner, Reddit, Capterra, TrustRadius, BBB, etc. -- whatever
  // the index actually has -- instead of forcing a narrow filter.
  // ============================================================

  if (BRAVE_KEY) {
    // Multiple complementary queries hit different review surfaces.
    var queries = [
      comp + ' reviews',
      comp + ' customer reviews complaints',
      comp + ' review reddit',
      comp + ' alternative OR competitor "switched from"',
      comp + ' problems OR issues OR disappointed',
      comp + ' g2 OR trustpilot OR capterra OR gartner reviews'
    ];

    // Run all Brave queries in PARALLEL to stay within function timeout
    var braveResponses = await Promise.all(queries.map(function(q){
      var braveQ = encodeURIComponent(q);
      return safeFetch(
        'https://api.search.brave.com/res/v1/web/search?q=' + braveQ + '&count=20&freshness=py&result_filter=web',
        { headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY } }
      ).then(function(resp){ return resp ? resp.json().catch(function(){ return null; }) : null; })
       .catch(function(){ return null; });
    }));

    braveResponses.forEach(function(bData){
      var webResults = (bData && bData.web && bData.web.results) || [];
      webResults.forEach(function(wr){
          // Combine title + description + any extra snippets for richer text
          var parts = [wr.title || '', wr.description || ''];
          if (wr.extra_snippets && wr.extra_snippets.length) {
            parts = parts.concat(wr.extra_snippets);
          }
          var text = parts.join('. ').replace(/<[^>]+>/g, '').trim();
          if (text.length < 40) return;

          // Must actually mention the competitor (title or body)
          var hay = (wr.title + ' ' + text + ' ' + (wr.url||'')).toLowerCase();
          if (hay.indexOf(comp.toLowerCase()) < 0) return;

          var u = (wr.url || '').toLowerCase();
          var platform =
            u.indexOf('g2.com') >= 0 ? 'g2' :
            u.indexOf('trustpilot') >= 0 ? 'trustpilot' :
            u.indexOf('capterra') >= 0 ? 'capterra' :
            u.indexOf('trustradius') >= 0 ? 'trustradius' :
            u.indexOf('gartner') >= 0 ? 'gartner' :
            u.indexOf('bbb.org') >= 0 ? 'bbb' :
            u.indexOf('reddit.com') >= 0 ? 'reddit' :
            u.indexOf('yelp.com') >= 0 ? 'yelp' :
            u.indexOf('sitejabber') >= 0 ? 'sitejabber' :
            u.indexOf('consumeraffairs') >= 0 ? 'consumeraffairs' :
            u.indexOf('pissedconsumer') >= 0 ? 'pissedconsumer' :
            u.indexOf('softwareadvice') >= 0 ? 'softwareadvice' :
            u.indexOf('peerspot') >= 0 ? 'peerspot' :
            u.indexOf('reviews.io') >= 0 ? 'reviews.io' :
            (u.indexOf('google.com') >= 0 || u.indexOf('google.') >= 0) ? 'google' :
            'web';
          results.push(buildReview(platform, wr.title || '', text, '', wr.url || '', '', comp));
      });
    });
  }

  // ---- Reddit via JSON API (works when Reddit allows; harmless if blocked) ----
  try {
    var redditQ = encodeURIComponent(comp + ' (review OR experience OR alternative OR problem OR disappointed)');
    var rResp = await safeFetch('https://www.reddit.com/search.json?q=' + redditQ + '&sort=relevance&limit=20&t=year', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelorahReviewIntel/1.0)' }
    });
    if (rResp) {
      var rData = await rResp.json();
      var children = (rData && rData.data && rData.data.children) || [];
      children.forEach(function(ch){
        var d = ch.data || {};
        var text = (d.selftext || d.title || '');
        if (text.length < 30) return;
        if ((d.title + ' ' + text).toLowerCase().indexOf(comp.toLowerCase()) < 0) return;
        results.push(buildReview('reddit', d.title || '', text, d.author || '', 'https://reddit.com' + (d.permalink || ''), d.created_utc ? new Date(d.created_utc*1000).toISOString() : '', comp));
      });
    }
  } catch(e) {}

  // ---- HackerNews (works server-side, good for tech products) ----
  try {
    var hnResp = await safeFetch('https://hn.algolia.com/api/v1/search?query=' + encodeURIComponent(comp) + '&tags=(story,comment)&hitsPerPage=20');
    if (hnResp) {
      var hnData = await hnResp.json();
      (hnData.hits || []).forEach(function(hit){
        var text = (hit.comment_text || hit.story_text || hit.title || '').replace(/<[^>]+>/g, '');
        if (text.length < 40) return;
        if (text.toLowerCase().indexOf(comp.toLowerCase()) < 0) return;
        results.push(buildReview('hackernews', hit.title || '', text, hit.author || '', 'https://news.ycombinator.com/item?id=' + (hit.objectID || ''), hit.created_at || '', comp));
      });
    }
  } catch(e) {}

  // ---- Sentiment filter + dedup by URL and by snippet ----
  var seenUrl = {}, seenText = {};
  results = results.filter(function(r){
    var uKey = (r.url || '').split('?')[0];
    var tKey = (r.snippet || '').substring(0, 80).toLowerCase().replace(/\s+/g, ' ');
    if (uKey && seenUrl[uKey]) return false;
    if (seenText[tKey]) return false;
    seenUrl[uKey] = true; seenText[tKey] = true;
    if (sentimentFilter && sentimentFilter !== 'all' && r.sentiment !== sentimentFilter) return false;
    return true;
  });

  // Sort: negative + lead-ready first (most actionable), then by pain count
  results.sort(function(a, b){
    var aScore = (a.sentiment === 'negative' ? 100 : a.sentiment === 'mixed' ? 50 : 0) + a.painPoints.length * 5 + (a.leadReady ? 20 : 0);
    var bScore = (b.sentiment === 'negative' ? 100 : b.sentiment === 'mixed' ? 50 : 0) + b.painPoints.length * 5 + (b.leadReady ? 20 : 0);
    return bScore - aScore;
  });

  return results.slice(0, maxPer);
}

function buildReview(platform, title, text, author, url, date, competitor) {
  var sent = scoreSentiment(text);
  var pains = extractPainPoints(text);
  var loves = extractLovePoints(text);
  var company = extractCompany(text);
  var firmo = extractFirmographics(text);

  // Refinement: a 'mixed' review that names a concrete pain point is, for outreach
  // purposes, a negative signal -- the reviewer has an actionable complaint.
  var finalSentiment = sent.sentiment;
  if (finalSentiment === 'mixed' && pains.length > 0 && sent.negScore >= sent.posScore) {
    finalSentiment = 'negative';
  }
  // Inversely: a 'mixed' with zero complaints and net-positive wording reads positive
  if (finalSentiment === 'mixed' && pains.length === 0 && sent.posScore > sent.negScore) {
    finalSentiment = 'positive';
  }
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
    sentiment:   finalSentiment,
    painPoints:  pains,
    lovePoints:  loves,
    company:     company,            // company they work at, IF publicly stated
    companySize: firmo.companySize,
    industry:    firmo.industry,
    // Explicit: no email, no phone, no private data -- by design
    leadReady:   (company && (finalSentiment === 'negative' || pains.length > 0)) ? true : false
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
      topPains:  {},
      topLoves:  {}
    };
    reviews.forEach(function(r){
      r.painPoints.forEach(function(p){ summary.topPains[p]=(summary.topPains[p]||0)+1; });
      (r.lovePoints||[]).forEach(function(p){ summary.topLoves[p]=(summary.topLoves[p]||0)+1; });
    });
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
