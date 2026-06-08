/**
 * VELORAH WEBSITE VISITOR TRACKER -- Argus Watch
 * Add to every page on xcigence.com before </body>
 *
 *   <script src="https://portal.xcigence.com/velorah-tracker.js"></script>
 */
(function() {
  var ENDPOINT = 'https://portal.xcigence.com/.netlify/functions/visitor-track';

  // Skip localhost and bots
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') return;
  if (/bot|crawl|spider|headless|prerender|lighthouse/i.test(navigator.userAgent)) return;

  // Session ID -- persists across pages in same visit
  function getSession() {
    var key = 'vl_sid';
    var sid = sessionStorage.getItem(key);
    if (!sid) {
      sid = Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
      sessionStorage.setItem(key, sid);
    }
    return sid;
  }

  // Page view count for this session
  function getPageViews() {
    var key = 'vl_pv';
    var pv = parseInt(sessionStorage.getItem(key) || '0') + 1;
    sessionStorage.setItem(key, String(pv));
    return pv;
  }

  // Device type
  function getDevice() {
    var ua = navigator.userAgent;
    if (/tablet|ipad|playbook|silk/i.test(ua)) return 'tablet';
    if (/mobile|iphone|ipod|android|blackberry|opera mini|windows phone/i.test(ua)) return 'mobile';
    return 'desktop';
  }

  var params = new URLSearchParams(window.location.search);
  var sessionId = getSession();
  var pageViews = getPageViews();
  var startTime = Date.now();

  var payload = {
    session_id:  sessionId,
    page:        window.location.href,
    path:        window.location.pathname,
    referrer:    document.referrer || '',
    title:       document.title,
    screen:      screen.width + 'x' + screen.height,
    device:      getDevice(),
    language:    navigator.language || '',
    tz:          Intl.DateTimeFormat().resolvedOptions().timeZone,
    page_views:  pageViews,
    user_agent:  navigator.userAgent,
    utm: {
      source:   params.get('utm_source')   || '',
      medium:   params.get('utm_medium')   || '',
      campaign: params.get('utm_campaign') || '',
      term:     params.get('utm_term')     || '',
      content:  params.get('utm_content')  || ''
    }
  };

  // Send page visit
  fetch(ENDPOINT, {
    method:    'POST',
    headers:   { 'Content-Type': 'application/json' },
    body:      JSON.stringify(payload),
    keepalive: true
  }).catch(function() {});

  // On page leave -- send time spent
  window.addEventListener('beforeunload', function() {
    var timeSpent = Math.round((Date.now() - startTime) / 1000);
    if (timeSpent < 2) return;
    fetch(ENDPOINT, {
      method:    'POST',
      headers:   { 'Content-Type': 'application/json' },
      body:      JSON.stringify(Object.assign({}, payload, {
        event:      'exit',
        time_spent: timeSpent,
        page_views: pageViews
      })),
      keepalive: true
    }).catch(function() {});
  });

})();
